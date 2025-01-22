import { loadShader } from "./utils";

export type RescaleMetadata = {
    slope: number,
    intercept: number,
}
export async function rescalePixelData(device:GPUDevice, pixelData:Float32Array, metadata:RescaleMetadata):Promise<Float32Array> {
    // Create buffer for input data
    const inputBuffer = device.createBuffer({
        size: pixelData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(inputBuffer, 0, pixelData);

    // Create buffer for output data
    const outputBuffer = device.createBuffer({
        size: pixelData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Create uniform buffer for slope and intercept
    const uniformBuffer = device.createBuffer({
        size: 8, // 2 * float32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([metadata.slope, metadata.intercept]));

    // Create bind group layout
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "read-only-storage" }
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "storage" }
            },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform" }
            }
        ]
    });
    const shaderCode = await loadShader('computeRescaling.wgsl');
    // Create pipeline
    const computePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        }),
        compute: {
            module: device.createShaderModule({
                code: shaderCode
            }),
            entryPoint: "main"
        }
    });

    // Create bind group
    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
            { binding: 2, resource: { buffer: uniformBuffer } }
        ]
    });

    // Create command encoder and pass
    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(computePipeline);
    passEncoder.setBindGroup(0, bindGroup);

    // Dispatch workgroups
    const workgroupSize = 256;
    const numWorkgroups = Math.ceil(pixelData.length / workgroupSize);
    passEncoder.dispatchWorkgroups(numWorkgroups);
    passEncoder.end();

    // Submit commands
    device.queue.submit([commandEncoder.finish()]);

    // Read back the results
    const readbackBuffer = device.createBuffer({
        size: pixelData.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    commandEncoder.copyBufferToBuffer(
        outputBuffer, 0,
        readbackBuffer, 0,
        pixelData.byteLength
    );

    // Map the buffer and get the results
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const resultData = new Float32Array(readbackBuffer.getMappedRange());
    return resultData;
}
