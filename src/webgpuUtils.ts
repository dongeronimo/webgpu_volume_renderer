import { mat4 } from "gl-matrix";

///Returns the shader module and a vertex buffer layout and bind group layout compatible with it.
///This is for the offscreen shader. In the future i'll have many functions like that, one
///for each shader.
export function createOffscreenShaderModule(device:GPUDevice):[GPUShaderModule,GPUVertexBufferLayout, GPUBindGroupLayout]{
    const offscreenShaderModule = device.createShaderModule({
        code: `
struct Uniforms {
  modelMatrix : mat4x4f,
  viewMatrix : mat4x4f,
  projectionMatrix : mat4x4f,
}
struct VertexInput {
    @location(0) position: vec3<f32>, // vec3 position
    @location(1) normal: vec3<f32>,   // vec3 normal
    @location(2) uv: vec2<f32>,       // vec2 uv
};
struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>, // Position in clip space
    @location(0) uv:vec3<f32>
};
@binding(0) @group(0) var<uniform> uniforms : Uniforms;            
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = uniforms.projectionMatrix * uniforms.viewMatrix * uniforms.modelMatrix * vec4<f32>(input.position, 1.0);
    output.uv = (input.position + vec3<f32>(1,1,1)) * 0.5 ;
    return output;
}
    
@fragment
fn fs_main(in:VertexOutput) -> @location(0) vec4f {
    return vec4f(in.uv, 1.0);  
}
        `
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
        arrayStride: 8 * Float32Array.BYTES_PER_ELEMENT, // 3 (pos) + 3 (normal) + 2 (uv) = 8 floats
        attributes: [
          {
            // Position (vec3)
            shaderLocation: 0, // Matches the location in the vertex shader
            offset: 0,
            format: 'float32x3',
          },
          {
            // Normal (vec3)
            shaderLocation: 1, // Matches the location in the vertex shader
            offset: 3 * Float32Array.BYTES_PER_ELEMENT, // After 3 floats for position
            format: 'float32x3',
          },
          {
            // UV (vec2)
            shaderLocation: 2, // Matches the location in the vertex shader
            offset: 6 * Float32Array.BYTES_PER_ELEMENT, // After 6 floats for position + normal
            format: 'float32x2',
          },
        ],
      };

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: {
          type: 'uniform',
        }
      }]
    });
    return [offscreenShaderModule, vertexBufferLayout, bindGroupLayout];
}

// Update matrices in your render loop
export function updateMatrices(modelMatrix:mat4, viewMatrix:mat4, projectionMatrix:mat4,
  device:GPUDevice, buffer:GPUBuffer) {
  // Create a buffer to hold all matrix data
  const matrices = new Float32Array(4 * 4 * 3);
  
  // Copy each matrix into the buffer at the correct offset
  matrices.set(modelMatrix, 0);
  matrices.set(viewMatrix, 16);
  matrices.set(projectionMatrix, 32);
  
  // Write to GPU
  device.queue.writeBuffer(buffer, 0, matrices);
}