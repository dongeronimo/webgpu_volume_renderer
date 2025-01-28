struct Uniforms {
    modelMatrix : mat4x4f,
    viewMatrix : mat4x4f,
    projectionMatrix : mat4x4f,
    cameraPosition: vec3f,
    stepSize: f32,
    maxSteps: i32,
    minValue: f32,
    maxValue: f32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    @location(1) localPos: vec3<f32>,
};

@binding(0) @group(0) var<uniform> uniforms : Uniforms;            

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = (uniforms.modelMatrix * vec4<f32>(input.position, 1.0)).xyz;
    output.clipPosition = uniforms.projectionMatrix * uniforms.viewMatrix * vec4<f32>(worldPos, 1.0);
    output.worldPos = worldPos;
    output.localPos = input.position;
    return output;
}

// Changed binding setup to remove sampler since we're using textureLoad
@group(1) @binding(0) var texture3D: texture_3d<f32>;
@group(1) @binding(1) var volumeSampler: sampler;

fn scalarToColor(v:f32) -> vec4<f32>{
    let level = 1500.0;
    let window = 400.0;
     // First, denormalize the value back to its original range - remember that the val is normalized now.
    let originalValue = mix(uniforms.minValue, uniforms.maxValue, v);
    // Calculate window bounds in original value space
    let windowBottom = level - window / 2.0;
    let windowTop = level + window / 2.0;
    // Apply window/level in original value space
    let windowedVal = (originalValue - windowBottom) / (windowTop - windowBottom);
    // Clamp the result to [0,1]
    let sampledColor = clamp(windowedVal, 0.0, 1.0);
    return vec4<f32>(sampledColor);
}

fn sampleVolume(pos: vec3f) -> f32 {
    // Since pos is in local coordinates (-1 to 1)
    // We need to map it to texture coordinates (0 to 1)
    let texCoords = (pos + 1.0) * 0.5;
    
    // Now you can sample your volume texture - remember that the normalized value is in the a channel.
    return textureSample(texture3D, volumeSampler, texCoords).a;
}

fn worldDirectionToLocalDirection(worldDirection:vec3<f32>, modelMatrix:mat4x4f)->vec3<f32> {
    // Now transform this direction to local space
    // For a direction vector, we only need the 3x3 rotation/scale part of the model matrix
    let m0 = vec3f(modelMatrix[0].xyz);  // First column of model matrix
    let m1 = vec3f(modelMatrix[1].xyz);  // Second column
    let m2 = vec3f(modelMatrix[2].xyz);  // Third column
    // Get the scaling factors from the model matrix
    let scaleX = length(m0);
    let scaleY = length(m1);
    let scaleZ = length(m2);
    // Create the rotation matrix by normalizing the model matrix columns
    // This removes the scaling while keeping the rotation
    let rotMatrix = mat3x3f(
        m0 / scaleX,
        m1 / scaleY,
        m2 / scaleZ
    );
    // The transpose of a rotation matrix is its inverse!
    // This is a key property that saves us from needing an inverse function
    let localDirection = normalize(transpose(rotMatrix) * worldDirection);
    return localDirection;
}

fn marchRay(_position:vec3<f32>, direction:vec3<f32>, stepSize:f32, maxSteps:i32) -> vec4f {
    var position = _position;
    // Start with fully transparent black
    var accumColor = vec3f(0.0);    // RGB color accumulator
    var accumAlpha = 0.0;           // Alpha (opacity) accumulator
    // We'll use this to know when to stop (when opacity is nearly full)
    let OPACITY_THRESHOLD = 0.95;
    // Start marching through the volume
    var isValid = true;
    for (var i = 0; i < maxSteps; i++) {
        let sample = sampleVolume(position);
        // Check if we've left the volume (assuming cube from -1 to 1)
        if (any(position < vec3f(-1.0)) || any(position > vec3f(1.0))) {
            isValid = false; 
        }
        if (accumAlpha >= OPACITY_THRESHOLD) {
            isValid = false;
        }
        if(isValid){
            // Current position is already in local/texture space
            // So we can directly use it to sample our volume
            let scalarColor = scalarToColor(sample);
            
            accumColor += (1.0 - accumAlpha) * scalarColor.rgb * scalarColor.a;
            accumAlpha += (1.0 - accumAlpha) * scalarColor.a;
            // Move to next position along ray
            position += direction * stepSize;
        }
    }
    
    return vec4<f32>(accumColor, accumAlpha);
}
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let dimensions = vec3<f32>(256, 256, 94); //TODO: must come from the uniforms.
    let worldDirection = normalize(in.worldPos - uniforms.cameraPosition);
    let localDirection = worldDirectionToLocalDirection(worldDirection, uniforms.modelMatrix);
    let result = marchRay(in.worldPos, worldDirection, 0.01, 1024);
    return result;
}