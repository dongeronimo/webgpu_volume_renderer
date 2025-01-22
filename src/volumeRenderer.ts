import { Mesh } from "three";
import { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { packInterleaved } from "./packInterleaved";
import { GPUMesh } from "./gpuMesh";
import { WebgpuContext } from "./webgpuContext";
import { loadShader } from "./utils";
import { mat4, vec3 } from "gl-matrix";

function writeMatrix(dataView: DataView, offset: number, matrix: mat4): number {
    // gl-matrix matrices are column-major
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            const value = matrix[col * 4 + row];
            dataView.setFloat32(offset + (col * 4 + row) * 4, value, true);
        }
    }
    return offset + 16 * 4;
}

function writeVec3(dataView: DataView, offset: number, vector: vec3): number {
    dataView.setFloat32(offset, vector[0], true);
    dataView.setFloat32(offset + 4, vector[1], true);
    dataView.setFloat32(offset + 8, vector[2], true);
    // 4 bytes padding to maintain 16-byte alignment
    return offset + 16;
}
// Uniform buffer structure following WebGPU alignment rules
const uniformBufferSize = 
    16 * 4 + // modelMatrix (4x4 matrix)
    16 * 4 + // viewMatrix (4x4 matrix)
    16 * 4 + // projectionMatrix (4x4 matrix)
    16 + // cameraPosition (vec3 + 1 padding for alignment)
    4 + // stepSize (f32)
    4 + // maxSteps (i32)
    4 + // minValue (f32)
    4; // maxValue (f32)

export interface VolumeRendererUniforms {
    modelMatrix: mat4;
    viewMatrix: mat4;
    projectionMatrix: mat4;
    cameraPosition: vec3;
    stepSize: number;
    maxSteps: number;
    minValue: number;
    maxValue: number;
}


export class VolumeRenderer {
    render(dt: number, passEncoder: GPURenderPassEncoder) {
        passEncoder.setPipeline(this.pipeline!);
        passEncoder.setBindGroup(0, this.uniformBindGroup);
        passEncoder.setBindGroup(1, this.textureBindGroup);
        passEncoder.setVertexBuffer(0, this.cube!.vertexBuffer); 
        passEncoder.setIndexBuffer(this.cube!.indexBuffer, 'uint16');
        passEncoder.drawIndexed(this.cube!.numberOfIndices, 1, 0, 0, 0); 
    }
    private cube:GPUMesh|undefined = undefined;
    // private shaderModule:GPUShaderModule|undefined;
    private readonly device:GPUDevice;
    private readonly uniformBuffer:GPUBuffer;
    private readonly uniformsBindGroupLayout:GPUBindGroupLayout;
    private readonly textureBindGroupLayout:GPUBindGroupLayout;
    private readonly pipelineLayout:GPUPipelineLayout;
    private readonly uniformBindGroup:GPUBindGroup;
    private readonly textureBindGroup:GPUBindGroup;
    private readonly sampler:GPUSampler;
    private pipeline:GPURenderPipeline|undefined;
    constructor(device:GPUDevice, volumeTextureView:GPUTextureView){
        this.device = device;
        // Create uniform buffer
        this.uniformBuffer = device.createBuffer({
            size: uniformBufferSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create sampler
        this.sampler = device.createSampler({
            magFilter: 'nearest',  // Changed from 'linear' to 'nearest'
            minFilter: 'nearest',  // Changed from 'linear' to 'nearest'
            mipmapFilter: 'nearest',  // Changed from 'linear' to 'nearest'
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge'
        });
        // Create bind group layouts
        this.uniformsBindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" }
            }]
        });
        this.textureBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {
                        sampleType: "unfilterable-float",  // Changed from unfilterable-float
                        viewDimension: "3d",
                    },    
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,  // Added visibility
                    sampler: { type: 'non-filtering' }
                }
            ]
        });
        this.pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.uniformsBindGroupLayout, this.textureBindGroupLayout]
        });
        // Create bind groups
        this.uniformBindGroup = device.createBindGroup({
            layout: this.uniformsBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this.uniformBuffer }
            }]
        });

        this.textureBindGroup = device.createBindGroup({
            layout: this.textureBindGroupLayout,
            entries: [{
                binding: 0,
                resource: volumeTextureView // Assuming this is already created
            },{
                binding: 1,
                resource: this.sampler
            }]
        });
    }
    ///Has to be asynce because i load the shader code
    public async initialize(canvasFormat:GPUTextureFormat)
    {
        await this.loadCube();
        const shaderCode:string = await loadShader("volume.wgsl");
        // Create render pipeline
        this.pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            // multisample: {
            //     count:4
            // },
            vertex: {
                module: this.device.createShaderModule({
                    code: shaderCode
                }),
                entryPoint: "vs_main",
                buffers: [{
                    arrayStride: 32, // 3 (position) + 3 (normal) + 2 (uv) = 8 floats * 4 bytes
                    attributes: [
                        {
                            // position
                            shaderLocation: 0,
                            offset: 0,
                            format: "float32x3"
                        },
                        {
                            // normal
                            shaderLocation: 1,
                            offset: 12,
                            format: "float32x3"
                        },
                        {
                            // uv
                            shaderLocation: 2,
                            offset: 24,
                            format: "float32x2"
                        }
                    ]
                }]
            },
            fragment: {
                module: this.device.createShaderModule({
                    code: shaderCode
                }),
                entryPoint: "fs_main",
                targets: [{
                    format: canvasFormat,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                    writeMask: GPUColorWrite.ALL,
                }],
            },
            primitive: {
                topology: "triangle-list",
                cullMode: "back"
            },
            depthStencil: {
                depthWriteEnabled:false,
                depthCompare: "less",
                format: "depth24plus",
            },
        });        
        this.pipeline.label = "volume pipeline";
    }

    //the cube is the mesh that's used to render the volume. when this method is over,
    //this.cube will be defined
    private async loadCube(){
        const loader = new GLTFLoader(); 
        const gltf:GLTF = await loader.loadAsync('/models/cube.glb');
        const scene = gltf.scene;
        const meshName = scene.children.filter(o=>o.isMesh)[0].name;
        const staticMesh = scene.getObjectByName(meshName)! as Mesh;
        const geometry = staticMesh.geometry;
        const position = geometry.getAttribute('position').array as Float32Array;
        const normal = geometry.getAttribute('normal').array as Float32Array;
        const uv = geometry.getAttribute('uv').array as Float32Array;
        const indices = geometry.index!.array as Uint16Array;
        const interleavedData = packInterleaved(position, normal, uv);
        this.cube = new GPUMesh(this.device, interleavedData, indices, geometry.index!.count);
        this.cube.vertexBuffer.label = "volumeCubeVBO";
    }
    public updateUniforms(
        uniforms: VolumeRendererUniforms
    ): void {
        const uniformData = new ArrayBuffer(uniformBufferSize);
        const dataView = new DataView(uniformData);
        
        let offset = 0;
        
        // Write matrices (maintained 16-byte alignment)
        offset = writeMatrix(dataView, offset, uniforms.modelMatrix);
        offset = writeMatrix(dataView, offset, uniforms.viewMatrix);
        offset = writeMatrix(dataView, offset, uniforms.projectionMatrix);
        
        // Write camera position (vec3 + padding to maintain 16-byte alignment)
        offset = writeVec3(dataView, offset, uniforms.cameraPosition);
        
        // Write scalar values
        dataView.setFloat32(offset, uniforms.stepSize, true);
        offset += 4;
        
        dataView.setInt32(offset, uniforms.maxSteps, true);
        offset += 4;
        
        dataView.setFloat32(offset, uniforms.minValue, true);
        offset += 4;
        
        dataView.setFloat32(offset, uniforms.maxValue, true);
    
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    }
}