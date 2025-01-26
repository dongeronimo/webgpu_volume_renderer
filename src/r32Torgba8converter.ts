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
                    // Input texture must be storage texture since we need random access for gradient calculation
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'read-only',
                        format: 'r32float',
                        viewDimension: '3d',
                    }
                },
                {
                    // Output texture for the RGBA8 result
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
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

        // Uniform buffer layout (must be 16-byte aligned):
        // offset 0:  min_value (f32)
        // offset 4:  max_value (f32)
        // offset 8:  dimensions.x (u32)
        // offset 12: dimensions.y (u32)
        // offset 16: dimensions.z (u32)
        // offset 20: gradient_scale (f32)
        // offset 24: padding (8 bytes to maintain 16-byte alignment)
        const uniformBuffer = this.device.createBuffer({
            size: 32, // 24 bytes of data + 8 bytes padding for 16-byte alignment
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });

        new Float32Array(uniformBuffer.getMappedRange()).set([
            minValue,           // min_value: f32
            maxValue,           // max_value: f32
            dimensions[0],      // texture_dimensions.x: u32 as f32
            dimensions[1],      // texture_dimensions.y: u32 as f32
            dimensions[2],      // texture_dimensions.z: u32 as f32
            gradientScale,      // gradient_scale: f32
            0.0,               // padding[0] for 16-byte alignment
            0.0,               // padding[1] for 16-byte alignment
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

        // Calculate workgroups to exactly match image dimensions
        // Each workgroup processes 8x8x8 voxels, so we need to round up
        const workgroupsX = Math.ceil(dimensions[0] / 8);
        const workgroupsY = Math.ceil(dimensions[1] / 8);
        const workgroupsZ = Math.ceil(dimensions[2] / 8);

        // Dispatch exactly enough workgroups to cover all voxels
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

@group(0) @binding(0) var input_texture: texture_storage_3d<r32float, read>;
@group(0) @binding(1) var output_texture: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

fn get_normalized_value(value: f32) -> f32 {
    return saturate((value - uniforms.min_value) / (uniforms.max_value - uniforms.min_value));
}

fn calculate_gradient(pos: vec3<u32>) -> vec3<f32> {
    var gradient: vec3<f32>;
    let dims = uniforms.texture_dimensions;
    
    // Calculate X gradient with proper bounds checking
    let x1 = textureLoad(input_texture, 
        vec3<u32>(max(pos.x, 1u) - 1u, pos.y, pos.z)).r;
    let x2 = textureLoad(input_texture, 
        vec3<u32>(min(pos.x + 1u, dims.x - 1u), pos.y, pos.z)).r;
    gradient.x = (x2 - x1) * 0.5;
    
    // Calculate Y gradient with proper bounds checking
    let y1 = textureLoad(input_texture, 
        vec3<u32>(pos.x, max(pos.y, 1u) - 1u, pos.z)).r;
    let y2 = textureLoad(input_texture, 
        vec3<u32>(pos.x, min(pos.y + 1u, dims.y - 1u), pos.z)).r;
    gradient.y = (y2 - y1) * 0.5;
    
    // Calculate Z gradient with proper bounds checking
    let z1 = textureLoad(input_texture, 
        vec3<u32>(pos.x, pos.y, max(pos.z, 1u) - 1u)).r;
    let z2 = textureLoad(input_texture, 
        vec3<u32>(pos.x, pos.y, min(pos.z + 1u, dims.z - 1u))).r;
    gradient.z = (z2 - z1) * 0.5;
    
    return gradient * uniforms.gradient_scale;
}

@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dims = uniforms.texture_dimensions;
    let is_in_bounds = global_id.x < dims.x && 
                      global_id.y < dims.y && 
                      global_id.z < dims.z;
    
    // We must perform texture operations uniformly
    let original_value = textureLoad(input_texture, global_id).r;
    let normalized_value = get_normalized_value(original_value);
    let gradient = calculate_gradient(global_id);
    let gradient_color = abs(gradient);
    let result = vec4<f32>(gradient_color, normalized_value);
    
    if (is_in_bounds) {
        textureStore(output_texture, global_id, result);
    }
}
`;