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
                    num_groups_x: u32,
                    num_groups_y: u32,
                    num_groups_z: u32,
                    width: u32,
                    height: u32,
                    depth: u32,
                }

                @group(0) @binding(0) var input_texture: texture_storage_3d<r32float, read>;
                @group(0) @binding(1) var<storage, read_write> min_max_buffer: array<MinMax>;
                @group(0) @binding(2) var<uniform> params: Params;

                var<workgroup> shared_min: array<f32, 256>;
                var<workgroup> shared_max: array<f32, 256>;

                @compute @workgroup_size(256)
                fn main(@builtin(global_invocation_id) global_id: vec3<u32>, @builtin(local_invocation_id) local_id: vec3<u32>) {
                    var local_min = f32(3.402823466e+38);
                    var local_max = f32(-3.402823466e+38);
                    
                    // Check if within texture dimensions
                    if (global_id.x < params.width && 
                        global_id.y < params.height && 
                        global_id.z < params.depth) {
                        let value = textureLoad(input_texture, global_id).r;
                        local_min = value;
                        local_max = value;
                    }
                    
                    shared_min[local_id.x] = local_min;
                    shared_max[local_id.x] = local_max;
                    
                    workgroupBarrier();
                    
                    // Reduction using uniform control flow
                    for (var offset = 256u / 2u; offset > 0u; offset /= 2u) {
                        if (local_id.x < offset) {
                            shared_min[local_id.x] = min(shared_min[local_id.x], shared_min[local_id.x + offset]);
                            shared_max[local_id.x] = max(shared_max[local_id.x], shared_max[local_id.x + offset]);
                        }
                        workgroupBarrier();
                    }
                    
                    // Store final reduction result
                    if (local_id.x == 0u) {
                        let group_index = global_id.z * params.num_groups_y + global_id.y;
                        min_max_buffer[group_index] = MinMax(shared_min[0], shared_max[0]);
                    }
                }
            `
        });

        this.pipeline = null;
    }

    execute(
        commandEncoder: GPUCommandEncoder, 
        inputTexture: GPUTexture,
        dimensionSize:Array<number>
    ) {
        const workgroupSize = 256; // Fixed in shader
        const numGroupsX = Math.ceil(dimensionSize[0] / workgroupSize);
        const numGroupsY = Math.ceil(dimensionSize[1] / workgroupSize);
        const numGroupsZ = Math.ceil(dimensionSize[2] / workgroupSize);
        const numGroups = numGroupsX * numGroupsY * numGroupsZ;

        if (this.minMaxBuffer) {
            this.minMaxBuffer.destroy();
        }
        this.minMaxBuffer = this.device.createBuffer({
            size: numGroups * 8, // 4 bytes for min, 4 for max
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

        // Create uniform buffer for parameters
        const paramsBuffer = this.device.createBuffer({
            size: 32, // 4 bytes * 8 for u32
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true
        });
        const paramsData = new Uint32Array(paramsBuffer.getMappedRange());
        paramsData.set([
            numGroupsX, numGroupsY, numGroupsZ, 
            dimensionSize[0], dimensionSize[1], dimensionSize[2]
        ]);
        paramsBuffer.unmap();

        // Create compute pass
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