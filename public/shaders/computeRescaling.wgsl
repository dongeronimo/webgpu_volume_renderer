@group(0) @binding(0) var<storage, read> inputData: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputData: array<f32>;
@group(0) @binding(2) var<uniform> params: vec2f;  // x: slope, y: intercept

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    
    // Guard against out-of-bounds access
    if (index >= arrayLength(&inputData)) {
        return;
    }
    
    // Apply rescale slope and intercept
    outputData[index] = inputData[index] * params.x + params.y;
}