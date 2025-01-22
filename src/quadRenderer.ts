export interface QuadRendererOptions {
    device: GPUDevice;
    format: GPUTextureFormat;
}

export class QuadRenderer {
    private device: GPUDevice;
    private format: GPUTextureFormat;
    
    private vertexBuffer: GPUBuffer|undefined;
    private vertexBufferLayout: GPUVertexBufferLayout|undefined;
    private sampler: GPUSampler|undefined;
    private bindGroupLayout: GPUBindGroupLayout|undefined;
    private pipeline: GPURenderPipeline|undefined;

    constructor({ device, format}: QuadRendererOptions) {
        this.device = device;
        this.format = format;
        
        this.init();
    }

    private init(): void {
        // Create vertex buffer for the quad
        const vertices = new Float32Array([
            // Position (xy), TexCoord (uv)
            -1, -1,  0,  0,
             1, -1,  1,  0,
            -1,  1,  0,  1,
             1,  1,  1,  1,
        ]);

        this.vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
        this.vertexBuffer.unmap();

        // Create vertex buffer layout
        this.vertexBufferLayout = {
            arrayStride: 16,
            attributes: [
                {
                    format: 'float32x2' as GPUVertexFormat,
                    offset: 0,
                    shaderLocation: 0,
                },
                {
                    format: 'float32x2' as GPUVertexFormat,
                    offset: 8,
                    shaderLocation: 1,
                },
            ],
        };

        // Create sampler
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Create bind group layout
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {},
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {},
                },
            ],
        });

        // Create pipeline layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        // Create render pipeline
        this.pipeline = this.device.createRenderPipeline({
            primitive: { topology: `triangle-strip` },
            layout: pipelineLayout,
            vertex: {
                module: this.device.createShaderModule({
                    code: quadVertexShader,
                }),
                entryPoint: 'main',
                buffers: [this.vertexBufferLayout],
            },
            fragment: {
                module: this.device.createShaderModule({
                    code: quadFragmentShader,
                }),
                entryPoint: 'main',
                targets: [{
                    format: this.format,
                }],
            },
        });
    }
    private bindGroup:GPUBindGroup|undefined = undefined;
    public createBindGroup(textureView: GPUTextureView): GPUBindGroup {
        if(this.bindGroup == undefined)
        {
            this.bindGroup = this.device.createBindGroup({
                layout: this.bindGroupLayout!,
                entries: [
                    {
                        binding: 0,
                        resource: textureView!,
                    },
                    {
                        binding: 1,
                        resource: this.sampler!,
                    },
                ],
            });  
        }
        return this.bindGroup;
    }

    public render(
        commandEncoder: GPUCommandEncoder,
        targetTextureView: GPUTextureView,
        sourceTextureView: GPUTextureView
    ): void {
        // Create bind group for the source texture
        const bindGroup = this.createBindGroup(sourceTextureView);

        // Begin render pass
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: targetTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        // Draw quad
        renderPass.setPipeline(this.pipeline!);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.draw(4);
        renderPass.end();
    }

    // Getters for private properties if needed
    public getBindGroupLayout(): GPUBindGroupLayout {
        return this.bindGroupLayout!;
    }

    public getPipeline(): GPURenderPipeline {
        return this.pipeline!;
    }
}

// Keep shaders outside the class as constants
const quadVertexShader = `
@vertex
fn main(
    @location(0) position: vec2f,
    @location(1) texCoord: vec2f
) -> Fragment {
    var output: Fragment;
    output.position = vec4f(position, 0.0, 1.0);
    output.texCoord = texCoord;
    return output;
}

struct Fragment {
    @builtin(position) position: vec4f,
    @location(0) texCoord: vec2f,
}`;

const quadFragmentShader = `
@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var texSampler: sampler;

@fragment
fn main(
    @location(0) texCoord: vec2f
) -> @location(0) vec4f {
    return textureSample(inputTexture, texSampler, texCoord);
}`;