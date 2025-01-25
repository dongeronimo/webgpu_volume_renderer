import { mat4, vec3 } from "gl-matrix";
import { createDicom3DTexture, Dicom3dTexture, DicomMetadata, DicomSeriesLoader, getFileFromPath, readFileAsArray } from "./dicom";
import { OffscreenPass } from "./offscreenPass";
import { QuadRenderer } from "./quadRenderer";
import { VolumeRenderer, VolumeRendererUniforms } from "./volumeRenderer";
import { DicomSlopeInterceptOperation, MinMaxReductionOperation } from "./compute";
import { GPUMinMaxReducer } from "./minMaxCompute";
type offscreenPassCallback = (dt:number, commandEncoder:GPURenderPassEncoder)=>void;
class MyWebGPURenderer {
    private adapter:GPUAdapter|null = null;
    private device:GPUDevice|undefined = undefined;
    public Device():GPUDevice{return this.device!}
    private context:GPUCanvasContext|undefined = undefined;
    private canvasFormat:GPUTextureFormat|undefined = undefined;
    public Format():GPUTextureFormat {return this.canvasFormat!;}
    private canvasWidth:number = -1;
    public Width():number{return this.canvasWidth;}
    private canvasHeight:number = -1;
    public Height():number{return this.canvasHeight;}
    private presentationRenderer:QuadRenderer|undefined;
    private offscreenPass:OffscreenPass|undefined;
    constructor(){
        
    }
    private offscreenTextureView:GPUTextureView|undefined = undefined;
    public async initialize(){
        await this.validateBrowser();
        this.device = await this.adapter!.requestDevice();
        const element = document.querySelector("#gpuCanvas")!;
        this.configureCanvasDimensions(element);
        this.context = (element as HTMLCanvasElement).getContext("webgpu") as GPUCanvasContext;
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.canvasFormat,
            alphaMode: "premultiplied",
        });
        console.log("initialize?")
        this.offscreenPass = new OffscreenPass({
            device: this.device,
            format: this.canvasFormat,
            width: this.canvasWidth,
            height: this.canvasHeight,
            sampleCount: 4
        });
        this.offscreenTextureView = this.offscreenPass.getResolveTextureView();
        this.presentationRenderer = new QuadRenderer({device:this.device, format:this.canvasFormat});
    }
    //if the browser can't run webgpu this function will blow up with an exeption.
    private async validateBrowser(){
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }
        this.adapter = await navigator.gpu.requestAdapter();
        if (!this.adapter) {
            throw new Error("No appropriate GPUAdapter found.");
        }
    }
    //I must make sure that the canvas size is equal to the dom element size.
    private configureCanvasDimensions(element:Element){
        this.canvasWidth = element.clientWidth * window.devicePixelRatio;
        this.canvasHeight = element.clientHeight * window.devicePixelRatio;
        const canvas = element as HTMLCanvasElement;
        canvas.width = this.canvasWidth; //this is necessary because the canvas size is not necessarely equal to its client size
        canvas.height = this.canvasHeight;
    }

    public render(callback:offscreenPassCallback){
        const commandEncoder = this.device!.createCommandEncoder();
        const renderPass = this.offscreenPass?.beginPass(commandEncoder,  
            { r: 0.1, g: 0.2, b: 0.3, a: 1 });
        renderPass!.label = "offscreen render pass";
        callback(-1, renderPass!);
        renderPass?.end();
        this.presentationRenderer?.render(commandEncoder, 
            this.context!.getCurrentTexture().createView(),
            this.offscreenTextureView!);
        this.device!.queue.submit([commandEncoder.finish()]);
    }
}
const seriesLoader = new DicomSeriesLoader();
async function ReadDicomFromDisk(){
    const dicomFilenames = await readFileAsArray("/FileList.txt")!;
    //append prefixes and suffixes.
    const fullPathFilenames = dicomFilenames!.map( (v, i)=>'/dicoms/'+v);
    //convert to File objects
    const dicomFiles: File[] = [];
    for(let i=0; i<fullPathFilenames.length; i++){
        dicomFiles.push( await getFileFromPath(fullPathFilenames[i]))
    }
    
    const dicomMetadatas: DicomMetadata[] = [];
    for(let i=0; i<dicomFiles.length; i++){
        try{
        dicomMetadatas.push(await seriesLoader.loadDicomFile(dicomFiles[i]));
        }catch(e){
            console.error("fail to open file "+e);
        }
    }
    return dicomMetadatas;
}
let dicomTextureObject:Dicom3dTexture;
let volumeRenderer:VolumeRenderer;
let slopeInterceptResult: GPUTexture;
async function main() {
    let canRender = true;
    const renderer:MyWebGPURenderer = new MyWebGPURenderer();
    await renderer.initialize();
    const dicomMetadataList:DicomMetadata[] = await ReadDicomFromDisk();
    dicomTextureObject = await createDicom3DTexture(renderer.Device(), dicomMetadataList, seriesLoader);
    dicomTextureObject.texture.label = "dicomTexture";
    //now we run the compute shaders on the image
    //1)Get the encoder and set some constants
    const slopeRescaleCommandEncoder = renderer.Device().createCommandEncoder();
    const width = dicomMetadataList[0].columns;
    const height = dicomMetadataList[0].rows;
    const depth = dicomMetadataList.length;
    //2) do the slope-intercept calculation
    const slopeInterceptOperation:DicomSlopeInterceptOperation = 
        new DicomSlopeInterceptOperation(
            renderer.Device(), 
            dicomMetadataList[0].slope, 
            dicomMetadataList[0].intercept);
    slopeInterceptResult = renderer.Device().createTexture({
        size: [width, height, depth],
        dimension: '3d',
        label:"slopeInterceptOutput",
        format: 'r32float',  // Single channel 32-bit float
        usage: GPUTextureUsage.TEXTURE_BINDING | 
               GPUTextureUsage.COPY_DST |
               GPUTextureUsage.STORAGE_BINDING |
               GPUTextureUsage.COPY_SRC
    });
    slopeInterceptOperation.execute(slopeRescaleCommandEncoder, {
        inputTexture: dicomTextureObject.texture,
        outputTexture: slopeInterceptResult,
    },{x:1, y:1, z:1});
    const slopeInterceptCommandBuffer = slopeRescaleCommandEncoder.finish();
    renderer.Device().queue.submit([slopeInterceptCommandBuffer]);
    await renderer.Device().queue.onSubmittedWorkDone();
    
    const minMaxReducer:GPUMinMaxReducer = new GPUMinMaxReducer(renderer.Device());
    const commandEncoder = renderer.Device().createCommandEncoder();
    minMaxReducer.execute(commandEncoder, slopeInterceptResult, [width, height, depth]);
    renderer.Device().queue.submit([commandEncoder.finish()]);
    
    const { min, max } = await minMaxReducer.getMinMaxValues();

    console.log("values ", min, max);
    volumeRenderer = new VolumeRenderer(renderer.Device(), dicomTextureObject.view);
    await volumeRenderer.initialize(renderer.Format());
    let alpha = 0;
    const speed = 0.34906585;
    let t0 = 0;
    const doRender = (t:number)=>{
        if(!canRender)
            return;
        t = t *0.001;
        const dt = t - t0;
        t0 = t;

        let perspective = mat4.create();
        perspective = mat4.perspective(perspective, 1.04719755, renderer.Width()/renderer.Height(),0.1, 20);
        let view = mat4.create();
        alpha = alpha+speed*dt;
        let x = Math.sin(alpha)*3;
        let z = Math.cos(alpha)*3;
        view = mat4.lookAt(view, [x, 0, z], [0,0,0], [0,1,0]);
        let model = mat4.create();
        model = mat4.identity(model);
        const uniforms: VolumeRendererUniforms = {
            modelMatrix: model,
            viewMatrix: view,
            projectionMatrix: perspective,
            cameraPosition: vec3.fromValues(x, 0, z),
            stepSize: 0.01,
            maxSteps: 100,
            minValue: 0.0,
            maxValue: 1.0
        };
        volumeRenderer.updateUniforms(uniforms);
        renderer.render((dt:number, commandEncoder:GPURenderPassEncoder)=>{
            volumeRenderer.render(dt, commandEncoder);
        });
        requestAnimationFrame(doRender);
    };
    document.addEventListener("visibilitychange", ()=>{
        if(document.hidden){
            console.log("visibility lost, stop rendering.");
            canRender = false;
        }
        else {
            console.log("visibility acquired, begin rendering.");
            canRender = true;
            requestAnimationFrame(doRender);
        }
    });
    requestAnimationFrame(doRender);
}

main();