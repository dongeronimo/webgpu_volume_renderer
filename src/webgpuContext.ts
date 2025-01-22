export type Texture = {
    tex: GPUTexture;
    view:GPUTextureView
} 
//Holds important data for the rendering context.
//It holds the device, gpuContext, adapter... and also the the offscreen render pass
//texture and presentation pass infrastructure.
//I can't initialize the context in the constructor because i need an async function 
//and i can't have async in ctor. So to initialize the context you call initializeWebGPU.
export class WebgpuContext {
    private device:GPUDevice|undefined = undefined;
    private context:GPUCanvasContext|undefined = undefined;
    private canvasFormat:GPUTextureFormat|undefined = undefined;
    private adapter:GPUAdapter|null = null;
    private canvasWidth:number = -1;
    private canvasHeight:number = -1;
    private resizeObserver:ResizeObserver;
    private offscreenTexture:Texture|undefined = undefined;
    private msaaTexture:Texture|undefined = undefined;
    private depthTexture:Texture|undefined = undefined;
    private presentationSampler:GPUSampler|undefined = undefined;
    private presentationShaderModule:GPUShaderModule|undefined = undefined;
    private presentationBindGroupLayout:GPUBindGroupLayout|undefined = undefined;
    private presentationPipelineLayout:GPUPipelineLayout|undefined = undefined;
    private presentationPipeline:GPURenderPipeline|undefined = undefined;
    private presentationBindGroup:GPUBindGroup|undefined = undefined;
    public Device():GPUDevice{return this.device!;}
    public Context():GPUCanvasContext{return this.context!;}
    public CanvasFormat():GPUTextureFormat{return this.canvasFormat!;}
    public Adapter():GPUAdapter{return this.adapter!;}

    private updateDimensions(){
        const element = document.querySelector("#gpuCanvas")!;
        this.canvasWidth = element.clientWidth * window.devicePixelRatio;
        this.canvasHeight = element.clientHeight * window.devicePixelRatio;
        const canvas = element as HTMLCanvasElement;
        canvas.width = this.canvasWidth; //this is necessary because the canvas size is not necessarely equal to its client size
        canvas.height = this.canvasHeight;
    }
    //remember that the constructor don't do much by itself and you must call initializeWebGPU to actually use the context
    constructor(){
        this.resizeObserver = new ResizeObserver(entries => {
            console.assert(entries.length == 1, "i expect to observe only a single canvas.");
            this.updateDimensions();
            this.createOffscreenRenderPassInfrastructure();
        });
    }
    //load a shader module from the public folder.
    public async loadShaderModule(device:GPUDevice, filepath:string):Promise<GPUShaderModule>{
        // Fetch the WGSL shader code from the file
        const response = await fetch(filepath);
        const shaderCode = await response.text();
        // Create a shader module
        const sh = device.createShaderModule({
            code: shaderCode,
        });
        return sh;
    }
    //do the actual initialization of webgpu. Device, Context, CanvasFormat and Adapter will
    //be available once this method finishes.
    //TODO: hardcoded canvas size = 800x600.
    public async initializeWebgpu(){
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported on this browser.");
        }
        this.adapter = await navigator.gpu.requestAdapter();
        if (!this.adapter) {
            throw new Error("No appropriate GPUAdapter found.");
        }
        this.device = await this.adapter!.requestDevice();
        const element = document.querySelector("#gpuCanvas")!;
        const canvas = element as HTMLCanvasElement;
        this.updateDimensions();
        this.resizeObserver.observe(element);
        this.context = canvas.getContext("webgpu") as GPUCanvasContext;
        if (!this.context) {
            throw new Error("Failed to get WebGPU context");
        }
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.canvasFormat,
            alphaMode: "premultiplied",
        });
        this.presentationSampler = this.createSampler('linear','clamp-to-edge', 16);

        this.presentationShaderModule = await this.loadShaderModule(this.device!, 'shaders/presentation.wgsl');
        this.presentationBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {//bind #0 for sampler
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                },
                {//bind #1 for texture
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {
                        sampleType: 'float',//if the texture is brga8unorm then it must sample as float
                        viewDimension: '2d'
                    }
                }
            ]});
        console.log("created presentation bind group layout: "+ this.presentationBindGroupLayout);
        this.createOffscreenRenderPassInfrastructure();
        this.presentationPipelineLayout = this.device.createPipelineLayout({
                bindGroupLayouts: [this.presentationBindGroupLayout]
            });
        this.presentationPipeline = this.device.createRenderPipeline({
            layout: this.presentationPipelineLayout,
            vertex: {
                module: this.presentationShaderModule,
                entryPoint: 'vs_main',
                // No vertex buffers needed since positions are hardcoded in the shader
            },
            fragment: {
                module: this.presentationShaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.canvasFormat
                }]
            },
            primitive: {
                topology: 'triangle-strip',
                stripIndexFormat: 'uint32'
            }
        });

    }
    //creates a sampler. mag,min and mipmap will have the same filter. All address modes 
    //will be the same too.
    public createSampler(filter:GPUFilterMode, addressMode:GPUAddressMode, aniso:number){
        const sampler = this.device!.createSampler({
            magFilter: filter,    // For upscaling
            minFilter: filter,    // For downscaling
            mipmapFilter: filter, // If using mipmaps
            lodMinClamp: 0,
            lodMaxClamp: 1,
            maxAnisotropy: aniso, // Try enabling anisotropic filtering
            addressModeU: addressMode,
            addressModeV: addressMode,
            addressModeW: addressMode,
        });  
        return sampler;
    }
    //creates a texture with the given size and it's view.
    public createTexture(w:number, h:number, format:GPUTextureFormat, usage: number, label?:string):Texture{
        const offscreenTextureSize = { width: w , height: h}; 
        const tex:GPUTexture = this.device!.createTexture({
            size: offscreenTextureSize, 
            format: format, 
            usage: usage});
        if(label) tex.label = label
        const view:GPUTextureView = tex.createView();
        if(label) view.label = `${label}View`;
        return {tex:tex, view:view};
    }
    //creates a msaa texture and it's view;
    public createMSAATexture(w:number, h:number, format:GPUTextureFormat, sampleCount:number, label?:string):Texture {
        const msaaTexture = this.device!.createTexture({
            size: {width:w, height:h},
            format: format,
            sampleCount: sampleCount, // 4x MSAA
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        });
        if(label)msaaTexture.label = label;
        const view = msaaTexture.createView();
        if(label)view.label = `${label}View`;
        return {tex:msaaTexture, view:view};
    }
    public createDepthTexture(w:number, h:number, sampleCount:number, label?:string):Texture {
        const depthTexture = this.device!.createTexture({
            size: [w, h, 1], // Match the swap chain size
            format: "depth24plus", // Common depth format
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: sampleCount, // Set the sample count for multisampling
        });
        const depthTextureView = depthTexture.createView();
        if(label){
            depthTexture.label = label;
            depthTextureView.label = `${label}View`;
        }
        return {tex:depthTexture, view:depthTextureView};
    }
    ///this depends upon the size of the canvas so it's called both at the 1st time initializeWebGPU is called and when
    ///the canvas is resized.
    private createOffscreenRenderPassInfrastructure(){
        this.offscreenTexture = this.createTexture(this.canvasWidth, this.canvasHeight,
            this.canvasFormat!, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            "OffscreenRenderTargetTexture");
        this.msaaTexture = this.createMSAATexture(this.canvasWidth, this.canvasHeight,
            this.canvasFormat!, 4, "OffscreenRenderTargetMSAATexture"
        );
        this.depthTexture = this.createDepthTexture(this.canvasWidth, this.canvasHeight, 4, "DepthBufferForRenderTarget");
        //this has to recreated here because it depends upon the new offscreen texture view
        console.log("will create the bind group layout:"+this.presentationBindGroupLayout);
        this.presentationBindGroup = this.device!.createBindGroup({
            layout: this.presentationBindGroupLayout!,
            entries: [
                {
                    binding: 0,
                    resource: this.presentationSampler!  // Your existing sampler
                },
                {
                    binding: 1,
                    resource: this.offscreenTexture!.view!  // Your existing texture
                }
            ]
        });
    }
    //run the presentation render pass.
    public UsePresentationPass(commandEncoder:GPUCommandEncoder){
        const presentationPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.context!.getCurrentTexture().createView(), //gets the next image in the swap chain
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        });
        presentationPass.setPipeline(this.presentationPipeline!);
        presentationPass.setBindGroup(0,//bind at descriptor set #0. See @group(0) in the presentation shader
            this.presentationBindGroup!);
        presentationPass.draw(4);  // Quad requires 4 vertices
        presentationPass.end();
    }
}