export interface TextureTransformOptions {
  inputTexture: GPUTexture;
  outputTexture: GPUTexture;
  bindGroupLayout?: GPUBindGroupLayout;
  pipelineLayout?: GPUPipelineLayout;
}

export type WorkgroupSize = {
  x: number,
  y: number,
  z: number
}

export abstract class ComputeShaderOperation {
  protected device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  abstract createBindGroup(options: TextureTransformOptions): GPUBindGroup;
  abstract createPipeline(options: TextureTransformOptions): GPUComputePipeline;
  abstract getShaderCode(): string;

  execute(
    commandEncoder: GPUCommandEncoder,
    options: TextureTransformOptions,
    wgSize: WorkgroupSize,
  ) {
    const bindGroup = this.createBindGroup(options);
    const pipeline = this.createPipeline(options);

    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(
      Math.ceil(options.inputTexture.width / wgSize.x),
      Math.ceil(options.inputTexture.height / wgSize.y),
      Math.ceil(options.inputTexture.depthOrArrayLayers / wgSize.z)
    );
    passEncoder.end();
  }
}

export class DicomSlopeInterceptOperation extends ComputeShaderOperation {
  private slope: number;
  private intercept: number;

  constructor(device: GPUDevice, slope: number, intercept: number) {
    super(device);
    this.slope = slope;
    this.intercept = intercept;
  }

  getShaderCode(): string {
    return `
        @group(0) @binding(0) var input_texture: texture_storage_3d<r32float, read>;
        @group(0) @binding(1) var output_texture: texture_storage_3d<r32float, write>;
  
        @compute @workgroup_size(8)
        fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
          let pixel_value = textureLoad(input_texture, global_id);
          let transformed_value = pixel_value * ${this.slope} + ${this.intercept};
          textureStore(output_texture, global_id, transformed_value);
        }
      `;
  }

  createBindGroup(options: TextureTransformOptions): GPUBindGroup {
    return this.device.createBindGroup({
      label: "dicomSlopeInterceptBindGroup",
      layout: this.createBindGroupLayout(),
      entries: [
        { binding: 0, resource: options.inputTexture.createView() },
        { binding: 1, resource: options.outputTexture.createView() }
      ]
    });
  }

  createPipeline(options: TextureTransformOptions): GPUComputePipeline {
    const shaderModule = this.device.createShaderModule({
      code: this.getShaderCode()
    });

    return this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.createBindGroupLayout()]
      }),
      compute: { module: shaderModule, entryPoint: 'main' },
      label: "dicomSlopeInterceptPipeline"
    });
  }

  private createBindGroupLayout(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      label: "dicomSlopeInterceptBindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'read-only',
            format: 'r32float',
            viewDimension: '3d'
          }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'r32float',
            viewDimension: '3d'
          }
        }
      ]
    });
  }
}

