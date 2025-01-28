export class R32toRGBA8Converter {
    private device: GPUDevice;
    private pipeline: GPUComputePipeline;
    private bindGroupLayout: GPUBindGroupLayout;

    constructor(device: GPUDevice) {
        this.device = device;
        [this.pipeline, this.bindGroupLayout] = this.createPipeline();
    }

    private createPipeline(): [GPUComputePipeline, GPUBindGroupLayout] {
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: "unfilterable-float",
                        viewDimension: "3d",
                    }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba16float',
                        viewDimension: '3d',
                    }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' }
                }
            ]
        });

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });

        const pipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: this.device.createShaderModule({ code: SHADER_CODE }),
                entryPoint: 'main'
            }
        });

        return [pipeline, bindGroupLayout];
    }

    async execute(
        commandEncoder: GPUCommandEncoder,
        params: {
            inputTexture: GPUTexture,
            outputTexture: GPUTexture,
            dimensions: [number, number, number],
            minValue: number,
            maxValue: number,
            gradientScale?: number
        }
    ) {
        const { inputTexture, outputTexture, dimensions, minValue, maxValue, gradientScale = 1.0 } = params;

        // Create uniform buffer with proper alignment
        const uniformBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });

        new Float32Array(uniformBuffer.getMappedRange()).set([
            minValue,
            maxValue,
            dimensions[0],
            dimensions[1],
            dimensions[2],
            gradientScale,
            0.0,
            0.0,
        ]);
        uniformBuffer.unmap();

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: inputTexture.createView() },
                { binding: 1, resource: outputTexture.createView() },
                { binding: 2, resource: { buffer: uniformBuffer } }
            ]
        });

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, bindGroup);

        const workgroupsX = Math.ceil(dimensions[0] / 4);
        const workgroupsY = Math.ceil(dimensions[1] / 4);
        const workgroupsZ = Math.ceil(dimensions[2] / 4);
        computePass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
        computePass.end();
    }
}

const SHADER_CODE = `
struct Uniforms {
    min_value: f32,
    max_value: f32,
    texture_dimensions: vec3<u32>,
    gradient_scale: f32,
}

@group(0) @binding(0) var input_texture: texture_3d<f32>;
@group(0) @binding(1) var output_texture: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

fn sample_normalized(pos:vec3<i32>)->f32{
    let raw = textureLoad(input_texture, pos, 0).r;
    let normalized = (raw - uniforms.min_value) / (uniforms.max_value - uniforms.min_value);
    return normalized;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    ///the position in the 3d texture
    let pos = vec3<i32>(global_id);
    //finite differences - dx
    let x1 = pos + vec3<i32>(pos.x+1, pos.y, pos.z);
    let x2 = pos + vec3<i32>(pos.x-1, pos.y, pos.z);
    let dx = (sample_normalized(x1)-sample_normalized(x2))/2.0;
    //finite differences - dy
    let y1 = pos + vec3<i32>(pos.x, pos.y+1, pos.z);
    let y2 = pos + vec3<i32>(pos.x, pos.y-1, pos.z);
    let dy = (sample_normalized(y1)-sample_normalized(y2))/2.0;
    //finite differences - dz
    let z1 = pos + vec3<i32>(pos.x, pos.y, pos.z+1);
    let z2 = pos + vec3<i32>(pos.x, pos.y, pos.z-1);
    let dz = (sample_normalized(z1)-sample_normalized(z2))/2.0;
    //final gradient
    let gradient = vec3<f32>(dx, dy, dz); //* uniforms.gradient_scale;
    let value = sample_normalized(pos);

    textureStore(output_texture, global_id, vec4<f32>(gradient, value));
}
`;