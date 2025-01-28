export class GPUMinMaxReducer {
    private device: GPUDevice;
    private shader: GPUShaderModule;
    private pipeline: GPUComputePipeline|null;
    private minMaxBuffer: GPUBuffer|null = null;

    constructor(device: GPUDevice) {
        this.device = device;

        this.shader = device.createShaderModule({
            code: `
                struct MinMax {
                    min: f32,
                    max: f32,
                }

                struct Params {
                    width: u32,
                    height: u32,
                    depth: u32,
                }

                @group(0) @binding(0) var input_texture: texture_storage_3d<r32float, read>;
                @group(0) @binding(1) var<storage, read_write> min_max_buffer: array<MinMax>;
                @group(0) @binding(2) var<uniform> params: Params;

                var<workgroup> shared_min: array<f32, 256>;
                var<workgroup> shared_max: array<f32, 256>;

                @compute @workgroup_size(8, 8, 4)
                fn main(@builtin(global_invocation_id) global_id: vec3<u32>, @builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) wg_id: vec3<u32>) {
                    let local_index = local_id.x + local_id.y * 8u + local_id.z * 64u;
                    
                    var local_min = f32(3.402823466e+38);
                    var local_max = f32(-3.402823466e+38);
                    
                    if (global_id.x < params.width && 
                        global_id.y < params.height && 
                        global_id.z < params.depth) {
                        let value = textureLoad(input_texture, global_id).r;
                        local_min = value;
                        local_max = value;
                    }
                    
                    shared_min[local_index] = local_min;
                    shared_max[local_index] = local_max;
                    
                    workgroupBarrier();
                    
                    // Reduction within workgroup
                    for (var offset = 128u; offset > 0u; offset = offset >> 1u) {
                        if (local_index < offset) {
                            shared_min[local_index] = min(shared_min[local_index], shared_min[local_index + offset]);
                            shared_max[local_index] = max(shared_max[local_index], shared_max[local_index + offset]);
                        }
                        workgroupBarrier();
                    }
                    
                    if (local_index == 0u) {
                        let groups_x = u32(ceil(f32(params.width) / 8.0));
                        let groups_y = u32(ceil(f32(params.height) / 8.0));
                        let buffer_index = wg_id.x + wg_id.y * groups_x + wg_id.z * groups_x * groups_y;
                        min_max_buffer[buffer_index] = MinMax(shared_min[0], shared_max[0]);
                    }
                }
            `
        });

        this.pipeline = null;
    }

    execute(
        commandEncoder: GPUCommandEncoder, 
        inputTexture: GPUTexture,
        dims: number[]
    ) {
        const [width, height, depth] = dims;
        const numGroupsX = Math.ceil(width / 8);
        const numGroupsY = Math.ceil(height / 8);
        const numGroupsZ = Math.ceil(depth / 4);
        const totalGroups = numGroupsX * numGroupsY * numGroupsZ;

        if (this.minMaxBuffer) {
            this.minMaxBuffer.destroy();
        }
        this.minMaxBuffer = this.device.createBuffer({
            size: totalGroups * 8,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            mappedAtCreation: false
        });

        if (!this.pipeline) {
            this.pipeline = this.device.createComputePipeline({
                layout: 'auto',
                compute: {
                    module: this.shader,
                    entryPoint: 'main'
                }
            });
        }

        const paramsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true
        });
        const paramsData = new Uint32Array(paramsBuffer.getMappedRange());
        paramsData.set([width, height, depth]);
        paramsBuffer.unmap();

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: inputTexture.createView() },
                { binding: 1, resource: { buffer: this.minMaxBuffer } },
                { binding: 2, resource: { buffer: paramsBuffer } }
            ]
        }));
        
        computePass.dispatchWorkgroups(numGroupsX, numGroupsY, numGroupsZ);
        computePass.end();
    }

    async getMinMaxValues(): Promise<{ min: number, max: number }> {
        const stagingBuffer = this.device.createBuffer({
            size: this.minMaxBuffer!.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(
            this.minMaxBuffer!, 0, 
            stagingBuffer, 0, 
            this.minMaxBuffer!.size
        );
        this.device.queue.submit([commandEncoder.finish()]);

        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const resultArray = new Float32Array(stagingBuffer.getMappedRange());

        let globalMin = Infinity;
        let globalMax = -Infinity;
        for (let i = 0; i < resultArray.length; i += 2) {
            globalMin = Math.min(globalMin, resultArray[i]);
            globalMax = Math.max(globalMax, resultArray[i + 1]);
        }

        stagingBuffer.unmap();
        return { min: globalMin, max: globalMax };
    }
}