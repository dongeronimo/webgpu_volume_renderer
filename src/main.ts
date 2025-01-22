import { Mesh } from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { packInterleaved } from './packInterleaved';
import { createOffscreenShaderModule, updateMatrices } from './webgpuUtils';
import { mat4 } from 'gl-matrix';
import { createBufferForVolumetricRender, createDicom3DTexture, CreateVolumeRendererShaderModule, Dicom3dTexture, DicomMetadata, DicomSeriesLoader, getFileFromPath, readFileAsArray, uploadToUniformBuffer } from './dicom';
import { VolumeRenderShader1 } from 'three/examples/jsm/Addons.js';
import { WebgpuContext } from './webgpuContext';
import { VolumeRenderer } from './volumeRenderer';
import { Renderer } from 'three/webgpu';
import { WebgpuRenderer } from './renderer';


// function createPresentationShaderModule(device:GPUDevice):GPUShaderModule {
//     const presentationShaderModule = device.createShaderModule({
//         code: `
//             struct VertexOutput {
//                 @builtin(position) position: vec4f,
//                 @location(0) texCoord: vec2f,
//             }
//             @vertex
//             fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
//                 var pos = array<vec2f, 4>(
//                     vec2f(-1.0, -1.0),
//                     vec2f( 1.0, -1.0),
//                     vec2f(-1.0,  1.0),
//                     vec2f( 1.0,  1.0)
//                 );
//                 var texCoord = array<vec2f, 4>(
//                     vec2f(0.0, 1.0),
//                     vec2f(1.0, 1.0),
//                     vec2f(0.0, 0.0),
//                     vec2f(1.0, 0.0)
//                 );
//                 var output: VertexOutput;
//                 output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
//                 output.texCoord = texCoord[vertexIndex];
//                 return output;
//             }
//             @group(0) @binding(0) var texSampler: sampler;
//             @group(0) @binding(1) var tex: texture_2d<f32>;
//             @fragment
//             fn fs_main(@location(0) texCoord: vec2f) -> @location(0) vec4f {
//                 return textureSample(tex, texSampler, texCoord);
//             }
//         `
//     });
//     return presentationShaderModule;
// }

// class GPUMesh {
//     public readonly vertexBuffer: GPUBuffer;
//     public readonly indexBuffer: GPUBuffer;
//     public readonly numberOfIndices:number;
//     constructor(device:GPUDevice, vertexBufferData:Float32Array, indexBufferData:Uint16Array, numberOfIndices:number){
//         this.numberOfIndices = numberOfIndices;
//         this.vertexBuffer = device.createBuffer({
//             size: vertexBufferData.byteLength,
//             usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
//         device.queue.writeBuffer(this.vertexBuffer, 0, vertexBufferData);
//         this.indexBuffer = device.createBuffer({
//             size: indexBufferData.byteLength,
//             usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST});
//         device.queue.writeBuffer(this.indexBuffer, 0, indexBufferData);
//     }
// }
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
const ctx:WebgpuContext = new WebgpuContext();
let volumeRenderer:VolumeRenderer|undefined = undefined;
async function main() {
    try {
        await ctx.initializeWebgpu();
        const renderer: WebgpuRenderer = new WebgpuRenderer(ctx);
        
        requestAnimationFrame(renderer.render.bind(renderer));
        //TODO refactor: create the volume renderer

        //let canvasWidth = document.querySelector("#gpuCanvas")!.clientWidth * window.devicePixelRatio;
        //let canvasHeight = document.querySelector("#gpuCanvas")!.clientHeight * window.devicePixelRatio;
        //create the offscreen texture that'll receive the scene.
        //creates the offscreen texture that'll render target of the offscreen render pass and sampled texture of the presentation pass.
        // const offscreenTextureSize = { width: canvasWidth , height: canvasHeight}; 
        // const offscreenTexture:GPUTexture = device.createTexture({
        //     size: offscreenTextureSize, 
        //     format: canvasFormat, 
        //     usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
        // Create multisampled texture for rendering
        // const msaaTexture = device.createTexture({
        //     size: offscreenTextureSize,
        //     format: canvasFormat,
        //     sampleCount: 4, // 4x MSAA
        //     usage: GPUTextureUsage.RENDER_ATTACHMENT
        // });
        // const depthTexture = device.createTexture({
        //     size: [canvasWidth, canvasHeight, 1], // Match the swap chain size
        //     format: "depth24plus", // Common depth format
        //     usage: GPUTextureUsage.RENDER_ATTACHMENT,
        //     sampleCount: 4, // Set the sample count for multisampling
        // });
        // const depthTextureView = depthTexture.createView();        
        //the linear sampler, it'll be used by the presentation render pass to sample the offsceen texture
        // const linearSampler = device.createSampler({
        //     magFilter: 'linear',    // For upscaling
        //     minFilter: 'linear',    // For downscaling
        //     mipmapFilter: 'linear', // If using mipmaps
        //     lodMinClamp: 0,
        //     lodMaxClamp: 1,
        //     maxAnisotropy: 16, // Try enabling anisotropic filtering
        //     addressModeU: 'clamp-to-edge',
        //     addressModeV: 'clamp-to-edge'
        // });        
        /////////////////////load the mesh and create the vertex and index buffer from it////////////////////////
        //const loader = new GLTFLoader();
        //remember that this object will be filled in the callback of loader.load
        // let cube:GPUMesh|undefined = undefined;
        // loader.load('/models/cube.glb',
        //     (gltf:GLTF)=>{
        //         //there can be many scenes but i'll only get the main and assume that there will always have just one scene
        //         const scene = gltf.scene;
        //         //getting hardcoded name. TODO: perse the list of of objects.
        //         //also i'm assuming, for this moment that this is a mesh and not a skinned mesh
        //         const meshName = scene.children.filter(o=>o.isMesh)[0].name;
        //         const staticMesh = scene.getObjectByName(meshName)! as Mesh;
        //         //get the geometry: position, normal and uv.
        //         const geometry = staticMesh.geometry;
        //         const position = geometry.getAttribute('position').array as Float32Array;
        //         const normal = geometry.getAttribute('normal').array as Float32Array;
        //         const uv = geometry.getAttribute('uv').array as Float32Array;
        //         //i'll always do indexed rendering. So i demand that the index list be present
        //         const indices = geometry.index!.array as Uint16Array;
        //         //create the vertex buffer and the index buffer
        //         //first i merge the buffers creating an interleaved buffer. 
        //         const interleavedData = packInterleaved(position, normal, uv);
        //         //then i create the object
        //         cube = new GPUMesh(device, interleavedData, indices, geometry.index!.count);
        //     },
        //     undefined,
        //     (error)=>{console.error(error);}
        // )
        //create the volume infrastructure
        // const [volumeRendererShader, //the shader module 
        //     volumeRendererBufferLayout, //the layout compatible with the shader
        //     volumeRendererUniformsBindGroupLayout, //the bind group for uniforms
        //     volumeRendererSamplerAndTexBindGroupLayout //the bind group for the texture and shader
        // ] = CreateVolumeRendererShaderModule(device);
        // //this will be defined once the texture object is build inside ReadDicomFromDisk.
        // let dicomTextureObject:Dicom3dTexture|undefined = undefined;
        // let dicomTextureView: GPUTextureView|undefined=undefined;
        // //read the file to get the list of files, in the future that'll come from a file.
        // ReadDicomFromDisk()
        //     //here i have a list of dicom metadatas - i assume for now that all images belong to the same series, study and patient
        //     .then((dicomMetadatas:DicomMetadata[])=>{
        //         return createDicom3DTexture(device, dicomMetadatas, seriesLoader);//read the metadatas and build the 3d texture.
        //     }).then((dicom3dTextureObject)=>{
        //         dicomTextureObject = dicom3dTextureObject;
        //         dicomTextureView = dicom3dTextureObject.texture.createView();
        //     });
        // //create the uniform buffer
        // const uniformBufferSize =  4 * 4 * 4 * 3; // 3 4x4 matrices, 4 bytes per float
        // const uniformBuffer = device.createBuffer({
        //     size: uniformBufferSize,
        //     usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        //   });
        

        // //the shader modules for the pipelines
        // //for the offscreen pipeline. I also need to create a bind group for it
        // const [offscreenShaderModule, offscreenVertexBufferLayout, offscreenBindGroupLayout] = 
        //     createOffscreenShaderModule(device);
        // const offscreenBindGroup = device.createBindGroup({
        //     layout: offscreenBindGroupLayout,
        //     entries:[{
        //         binding: 0,
        //         resource: {
        //             buffer: uniformBuffer
        //         }
        //     }]
        // });
        // // Create the pipeline layout
        // const offscreenPipelineLayout = device.createPipelineLayout({
        //     bindGroupLayouts: [offscreenBindGroupLayout]
        //   });
        // // const presentationShaderModule:GPUShaderModule = createPresentationShaderModule(device);
        // //the offscreen pipeline
        // const offscreenPipeline: GPURenderPipeline = device.createRenderPipeline({
        //     layout: offscreenPipelineLayout,
        //     vertex: {
        //         module: offscreenShaderModule,
        //         entryPoint: 'vs_main',
        //         buffers: [offscreenVertexBufferLayout] //the vertex buffer is expected to be in location #0, see the vertex buffer layout
        //     },
        //     fragment: {
        //         module: offscreenShaderModule,
        //         entryPoint: 'fs_main',
        //         targets: [{
        //             format: canvasFormat
        //         }]
        //     },
        //     depthStencil: {
        //         format: "depth24plus", // Match the depth texture format
        //         depthWriteEnabled: true,
        //         depthCompare: "less",
        //     },
        //     primitive: {
        //         topology: 'triangle-list'
        //     },
        //     multisample: {
        //         count: 4 // Must match the texture sampleCount
        //     }
        // });
        // //the buffer for the uniforms that the volumetric shader demands
        // const volumetricUniformBuffer = createBufferForVolumetricRender(device);
        // const volumetricPipelineLayout = device.createPipelineLayout({
        //     bindGroupLayouts:[volumeRendererUniformsBindGroupLayout, volumeRendererSamplerAndTexBindGroupLayout]
        // });
        // const volumetricPipeline: GPURenderPipeline = device.createRenderPipeline({
        //     layout: volumetricPipelineLayout,
        //     vertex: {
        //         module: volumeRendererShader,
        //         entryPoint: 'vs_main',
        //         buffers: [volumeRendererBufferLayout]
        //     },
        //     fragment: {
        //         module: volumeRendererShader,
        //         entryPoint: 'fs_main',
        //         targets:[{format:canvasFormat}]
        //     },
        //     depthStencil: {
        //         format: 'depth24plus',
        //         depthWriteEnabled: true,
        //         depthCompare: 'less'
        //     },
        //     primitive: {
        //         topology: 'triangle-list'
        //     },
        //     multisample: {
        //         count: 4 // Must match the texture sampleCount
        //     }
        // });
        // // Create the bind group using your existing sampler and texture.
        // const volumetricUniformBindGroup = device.createBindGroup({
        //     layout: volumeRendererUniformsBindGroupLayout,
        //     entries: [
        //         {
        //             binding: 0,
        //             resource: {
        //                 buffer: volumetricUniformBuffer,
        //             },
        //         },
        //     ],
        // });
        // //the sampler for the texture 3d
        // // const texture3dSampler = device.createSampler({
        // //     addressModeU: 'clamp-to-edge',    // Address mode for the U axis (x-axis)
        // //     addressModeV: 'clamp-to-edge',    // Address mode for the V axis (y-axis)
        // //     addressModeW: 'clamp-to-edge',    // Address mode for the W axis (z-axis)
        // //     magFilter: 'linear',       // Magnification filter
        // //     minFilter: 'linear',       // Minification filter
        // //     mipmapFilter: 'linear',    // Mipmap filter
        // //     maxAnisotropy: 1,          // Optional, anisotropic filtering
        // // })
        // //will only be defined when we create the texture 3d and, in the main loop, we create
        // //the volumetric texture bind group.
        // let volumetricTextureBindGroup:GPUBindGroup|undefined =undefined;
        
        // //the presentation render pass and the infrastructure
        // //describes the resources for the presentation render pass.
        // // const presentationBindGroupLayout = device.createBindGroupLayout({
        // //     entries: [
        // //         {//bind #0 for sampler
        // //             binding: 0,
        // //             visibility: GPUShaderStage.FRAGMENT,
        // //             sampler: { type: 'filtering' }
        // //         },
        // //         {//bind #1 for texture
        // //             binding: 1,
        // //             visibility: GPUShaderStage.FRAGMENT,
        // //             texture: {
        // //                 sampleType: 'float',//if the texture is brga8unorm then it must sample as float
        // //                 viewDimension: '2d'
        // //             }
        // //         }
        // //     ]
        // // });
        // // Create the pipeline layout using the bind group layout
        // // const presentationPipelineLayout = device.createPipelineLayout({
        // //     bindGroupLayouts: [presentationBindGroupLayout]
        // // });
        // // Create the presentation pipeline
        // // const presentationPipeline = device.createRenderPipeline({
        // //     layout: presentationPipelineLayout,
        // //     vertex: {
        // //         module: presentationShaderModule,
        // //         entryPoint: 'vs_main',
        // //         // No vertex buffers needed since positions are hardcoded in the shader
        // //     },
        // //     fragment: {
        // //         module: presentationShaderModule,
        // //         entryPoint: 'fs_main',
        // //         targets: [{
        // //             format: canvasFormat
        // //         }]
        // //     },
        // //     primitive: {
        // //         topology: 'triangle-strip',
        // //         stripIndexFormat: 'uint32'
        // //     }
        // // });
        // // Create the bind group using your existing sampler and texture.
        // // const presentationBindGroup = device.createBindGroup({
        // //     layout: presentationBindGroupLayout,
        // //     entries: [
        // //         {
        // //             binding: 0,
        // //             resource: linearSampler  // Your existing sampler
        // //         },
        // //         {
        // //             binding: 1,
        // //             resource: offscreenTexture.createView()  // Your existing texture
        // //         }
        // //     ]
        // // });
        // const angularSpeed = 1.5708;
        // let angle = 0;
        // let lastFrameTime: number = 0;
        // let deltaTime: number = 0;
        // const msaaTextureView = msaaTexture.createView();
        // const offscreenTargetView = offscreenTexture.createView();
        // //let us begin the render loop
        // const renderFn = (currentTime: number)=>{
        //     if(dicomTextureObject != undefined)
        //     {
        //         //the other bind group was already craeated
        //         volumetricTextureBindGroup = device.createBindGroup({
        //             layout: volumeRendererSamplerAndTexBindGroupLayout,
        //             entries: [
        //                 {
        //                     binding: 1,
        //                     resource: dicomTextureView!, // Your 3D texture view
        //                 },
        //             ],
        //         });
        //     }
        //     //calculate the delta time.
        //     currentTime *= 0.001;
        //     deltaTime = currentTime - lastFrameTime;
        //     lastFrameTime = currentTime;
        //     //update the matrices
        //     const modelMatrix = mat4.create();
        //     mat4.identity(modelMatrix);
        //     const viewMatrix = mat4.create();
        //     angle = angle + angularSpeed * deltaTime;
        //     const x = Math.sin(angle);
        //     const z = Math.cos(angle);
        //     mat4.lookAt(viewMatrix, [x*5,0,z*5], [0,0,0], [0,1,0]);
        //     const projectionMatrix = mat4.create();
        //     mat4.perspective(projectionMatrix, 1.047, canvasWidth/canvasHeight, 0.01, 100);
        //     //upload them to the buffer
        //     updateMatrices(modelMatrix, viewMatrix, projectionMatrix, device, uniformBuffer);
        //     // Create command encoder - the command encoder is equivalent to the vkCommandBuffer in vulkan. We use it to record commands that'll be run
        //     // in parallel in the gpu.
        //     const commandEncoder:GPUCommandEncoder = device.createCommandEncoder();
        //     // Offscreen pass
        //     const offscreenPass:GPURenderPassEncoder = commandEncoder.beginRenderPass({
        //         colorAttachments: [{
        //             view: msaaTextureView,
        //             resolveTarget: offscreenTargetView, // Results get resolved here
        //             clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        //             loadOp: 'clear',
        //             storeOp: 'store'
        //         }],
        //         depthStencilAttachment: {
        //             view: depthTextureView,
        //             depthClearValue: 1.0, // Default depth value
        //             depthLoadOp: "clear",
        //             depthStoreOp: "store",
        //           },  
        //     });
        //     if(volumetricTextureBindGroup != undefined)
        //     { 
        //         //upload data to the uniform buffer
        //         uploadToUniformBuffer(device, volumetricUniformBuffer, {
        //             modelMatrix: modelMatrix as Float32Array,
        //             viewMatrix: viewMatrix as Float32Array,
        //             projectionMatrix: projectionMatrix as Float32Array,
        //             cameraPosition: new Float32Array([x*5, 0, z*5]),
        //             stepSize: 0.01,
        //             maxSteps: 1024,
        //             minValue: 0,
        //             maxValue: 1
        //         });
        //         //set the volumetric pipeline
        //         offscreenPass.setPipeline(volumetricPipeline);
        //         offscreenPass.setBindGroup(0, volumetricUniformBindGroup);
        //         offscreenPass.setBindGroup(1, volumetricTextureBindGroup);
        //     }
        //     else //draw the old pipeline 
        //     {
        //         offscreenPass.setPipeline(offscreenPipeline);
        //         offscreenPass.setBindGroup(0,//bind at set 0 
        //             offscreenBindGroup);//the offscreen bind group links the uniform buffer to the pipeline
        //     }
        //     //TODO: when i have more then one mesh it's here that i'll switch meshes.
        //     if(cube != undefined) {
        //         offscreenPass.setVertexBuffer(0, cube.vertexBuffer);
        //         offscreenPass.setIndexBuffer(cube.indexBuffer, 'uint16');
        //         offscreenPass.drawIndexed(cube.numberOfIndices, 1,0,0,0);    
        //     }
        //     //the offscreen pass is done, we finish it. The scene is in the texture.
        //     offscreenPass.end();
        //     // Presentation pass
        //     const presentationPass = commandEncoder.beginRenderPass({
        //         colorAttachments: [{
        //             view: context.getCurrentTexture().createView(), //gets the next image in the swap chain
        //             clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        //             loadOp: 'clear',
        //             storeOp: 'store'
        //         }]
        //     });
        //     presentationPass.setPipeline(presentationPipeline);
        //     presentationPass.setBindGroup(0,//bind at descriptor set #0. See @group(0) in the presentation shader
        //         presentationBindGroup);
        //     presentationPass.draw(4);  // Quad requires 4 vertices
        //     presentationPass.end();

        //     // Submit commands
        //     device.queue.submit([commandEncoder.finish()]);
        //     //request next frame
        //     requestAnimationFrame(renderFn);
        // };
        // requestAnimationFrame(renderFn);
    } catch (error) {
        console.error("Failed to initialize WebGPU:", error);
    }
}

main();