import dicomParser from 'dicom-parser';
import { rescalePixelData } from './rescaleCompute';
export interface DicomMetadata {
    seriesInstanceUID: string;
    instanceNumber: number;
    sliceLocation: number;
    rows: number;
    columns: number;
    pixelSpacing: number[] | undefined;
    pixelData: DicomElement;
    slope: number;
    intercept: number;
    windowCenter?:number;
    windowWidth?:number;
}

export async function getFileFromPath(publicPath: string): Promise<File> {
    try {
      const response: Response = await fetch(publicPath);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const blob: Blob = await response.blob();
      const filename: string = publicPath.split('/').pop() || 'unknown_file';
      
      return new File([blob], filename, { type: blob.type });
    } catch (error) {
      throw new Error(`Failed to fetch file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  

export class DicomSeriesLoader {
    constructor() {
        this.volumes = new Map(); // Store different series
    }

    // Load a single DICOM file
    async loadDicomFile(file: File): Promise<DicomMetadata> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e:ProgressEvent<FileReader>) => {
                try {
                    // Convert FileReader result to arrayBuffer
                    const arrayBuffer = e.target!.result as ArrayBuffer;
                    const byteArray = new Uint8Array(arrayBuffer);
                    
                    // Parse DICOM file
                    const dataSet = dicomParser.parseDicom(byteArray);
                    const pixelDataElement = dataSet.elements.x7fe00010;
                    // Store the dataset reference in the pixel data element
                    pixelDataElement.dataSet = dataSet;
                    // Extract key metadata
                    const metadata = {
                        //identifies the patient
                        patientId: dataSet.string('x00100020'),
                        //identifies the imaging procedure
                        studyId:dataSet.string('x00200010'),
                        //identifies the series
                        seriesInstanceUID: dataSet.string('x0020000e'),
                        instanceNumber: parseInt(dataSet.string('x00200013')!),
                        sliceLocation: parseFloat(dataSet.string('x00201041')!),
                        rows: dataSet.uint16('x00280010'),
                        columns: dataSet.uint16('x00280011'),
                        pixelSpacing: dataSet.string('x00280030')?.split('\\').map(Number),
                        pixelData: pixelDataElement,
                        slope: dataSet.string('x00281053') ? parseFloat(dataSet.string('x00281053')!) : 1,
                        intercept: dataSet.string('x00281052') ? parseFloat(dataSet.string('x00281052')!) : 0,
                        windowCenter: dataSet.float('x00281050'),
                        windowWidth: dataSet.float('x00281051'),
                    };
                    resolve(metadata);
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    // Load multiple files that make up a series
    async loadSeries(files: File[]): Promise<Map<string, DicomMetadata[]>> {
        const loadedFiles = await Promise.all(
            files.map(file => this.loadDicomFile(file))
        );

        // Group files by series
        loadedFiles.forEach(metadata => {
            if (!this.volumes.has(metadata.seriesInstanceUID)) {
                this.volumes.set(metadata.seriesInstanceUID, []);
            }
            this.volumes.get(metadata.seriesInstanceUID).push(metadata);
        });

        // Sort each series by slice location
        for (let [seriesUID, slices] of this.volumes) {
            slices.sort((a, b) => a.sliceLocation - b.sliceLocation);
        }

        return this.volumes;
    }

    // Get pixel data as Float32Array with rescale slope and intercept applied
    async getPixelData(metadata:DicomMetadata, device:GPUDevice) {
        // Access the pixel data via the dataset
        const byteArray = metadata.pixelData.dataSet.byteArray;
        const offset = metadata.pixelData.dataOffset;
        const length = metadata.pixelData.length;

        // Create view of the data as 16-bit integers
        const pixelData = new Uint16Array(
            byteArray.buffer,
            offset,
            length / 2  // divide by 2 because Uint16 is 2 bytes per element
        );
        //TODO: move this to a compute shader and get the result. This can be heavily paralelized since every 
        //value is independent from all other values
        // Apply rescale slope and intercept
        const rawFloatData = new Float32Array(pixelData.length);
        //return await rescalePixelData(device, rawFloatData, {slope:metadata.slope, intercept:metadata.intercept});
        for (let i = 0; i < pixelData.length; i++) {
            rawFloatData[i] = pixelData[i];// * metadata.slope + metadata.intercept;
        }    
        return rawFloatData;
    }
}
// Function to read the file and convert it to an array of strings.I use that to get the list of files
//that i'm using until i have a server.
export async function readFileAsArray(filePath:string) : Promise<string[]|undefined>{
    try {
        const response = await fetch(filePath);
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
    
        // Get the raw binary data as an ArrayBuffer
        const arrayBuffer = await response.arrayBuffer();
    
        // Decode it as UTF-16 (little-endian by default)
        const text = new TextDecoder('utf-16le').decode(arrayBuffer);
    
        // Split the content into an array of lines
        const lines = text.split('\n').map(line => line.trim());
    
        // console.log(lines); // Logs the array of strings
        return lines;
      } catch (error) {
        console.error('Error reading the file:', error);
      }    
}
export class Dicom3dTexture {
    public readonly texture: GPUTexture;
    public readonly view:GPUTextureView;
    public readonly dimensions: [number, number, number];
    public readonly minValue: number;
    public readonly maxValue: number;
    constructor(texture: GPUTexture, dimensions: [number, number, number],minValue: number, maxValue: number){
        this.texture = texture;
        this.dimensions = dimensions;
        this.maxValue = maxValue;
        this.minValue = minValue;
        this.view = texture.createView();
    }
}
// Helper function to create a 3D texture from DICOM slices
export async function createDicom3DTexture(
    device: GPUDevice,
    dicomSlices: DicomMetadata[],
    loader: DicomSeriesLoader,
): Promise<Dicom3dTexture> {
    //assertion: some sanity checks
    if (dicomSlices.length === 0) {throw new Error('No DICOM slices provided');}
    // Get dimensions from first slice - all slices will have the same dimensions
    const width = dicomSlices[0].columns;
    const height = dicomSlices[0].rows;
    const depth = dicomSlices.length;

    // Create a single Float32Array to hold all slices
    const totalPixels = width * height * depth;
    const volumeData = new Float32Array(totalPixels);

    // Track min/max values for normalization if needed
    let minValue = Infinity;
    let maxValue = -Infinity;

    // Fill the volume data array
    for (let z = 0; z < depth; z++) {
        const slice = dicomSlices[z];
        const sliceData = await loader.getPixelData(slice, device);
        
        // Copy slice data into the volume
        const offset = z * width * height;
        for (let i = 0; i < sliceData.length; i++) {
            const value = sliceData[i];
            volumeData[offset + i] = value;
            minValue = Math.min(minValue, value);
            maxValue = Math.max(maxValue, value);
        }
    }

    // Create the 3D texture
    const texture = device.createTexture({
        size: [width, height, depth],
        dimension: '3d',
        format: 'r32float',  // Single channel 32-bit float
        usage: GPUTextureUsage.TEXTURE_BINDING | 
               GPUTextureUsage.COPY_DST |
               GPUTextureUsage.STORAGE_BINDING
    });

    // Create a temporary buffer to copy data to GPU
    const buffer = device.createBuffer({
        size: volumeData.byteLength,
        usage: GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true
    });

    // Copy volume data to the buffer
    new Float32Array(buffer.getMappedRange()).set(volumeData);
    buffer.unmap();

    // Copy the buffer to the texture
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToTexture(
        {
            buffer: buffer,
            bytesPerRow: width * 4,  // 4 bytes per float32
            rowsPerImage: height
        },
        {
            texture: texture
        },
        [width, height, depth]
    );

    // Submit commands
    device.queue.submit([encoder.finish()]);

    // Clean up the temporary buffer
    buffer.destroy();
    return new Dicom3dTexture(
        texture,
        [width, height, depth],
        minValue,
        maxValue
    );
}

export function CreateVolumeRendererShaderModule(device:GPUDevice):
    [GPUShaderModule,GPUVertexBufferLayout, GPUBindGroupLayout, GPUBindGroupLayout] {
    const offscreenShaderModule = device.createShaderModule({
        code: `
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
@group(1) @binding(0) var tex3d: texture_3d<f32>;

fn worldToLocal(worldPos: vec3<f32>) -> vec3<f32> {
    let inverseModel = transpose(uniforms.modelMatrix);
    return (inverseModel * vec4<f32>(worldPos, 1.0)).xyz;
}

fn transferFunction(value: f32) -> vec4<f32> {
    let normalizedValue = (value - uniforms.minValue) / (uniforms.maxValue - uniforms.minValue);
    let intensity = clamp(normalizedValue, 0.0, 1.0);
    return vec4<f32>(
        intensity,
        intensity,
        intensity,
        intensity * 0.95
    );
}

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_main(in: VertexOutput) -> FragmentOutput {
    let rayOrigin = worldToLocal(uniforms.cameraPosition);
    let rayDir = normalize(in.localPos - rayOrigin);
    var currentPos = in.localPos;
    var accColor = vec4<f32>(0.0);
    var output: FragmentOutput;
    output.depth = 1.0;

    for(var i: i32 = 0; i < uniforms.maxSteps; i = i + 1) {
        // Convert position to texture coordinates (0 to 1)
        let samplePos = (currentPos + 1.0) * 0.5;
        
        // Convert floating-point position to integer coordinates
        // Assuming your texture dimensions. You might want to pass these as uniforms
        let texCoord = vec3<i32>(
            i32(samplePos.x * 255.0),
            i32(samplePos.y * 255.0),
            i32(samplePos.z * 93.0)  // Adjusted for 94 depth (0-93)
        );
        
        // Use textureLoad instead of textureSample
        let sample = textureLoad(tex3d, texCoord, 0).r;
        let sampledColor = transferFunction(sample);
        
        let withinBounds = all(samplePos >= vec3<f32>(0.0)) && all(samplePos <= vec3<f32>(1.0));
        let notMaxedOut = accColor.a <= 0.99;
        
        if (withinBounds && notMaxedOut) {
            accColor = vec4<f32>(
                accColor.rgb + (1.0 - accColor.a) * sampledColor.rgb * sampledColor.a,
                accColor.a + (1.0 - accColor.a) * sampledColor.a
            );
            
            if (accColor.a > 0.95) {
                let clipPos = uniforms.projectionMatrix * uniforms.viewMatrix * vec4<f32>(currentPos, 1.0);
                output.depth = clipPos.z / clipPos.w;
            }
        }
        currentPos = currentPos + rayDir * uniforms.stepSize;
    } 
    
    output.color = accColor;
    return output;
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
    // Bind group layout for uniforms (group 0)
    const uniformsBindGroupLayout = device.createBindGroupLayout({
    entries: [
        {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: {
                type: 'uniform',
            }
        },
    ]
    });

    // Bind group layout for texture and sampler (group 1)
    const textureBindGroupLayout = device.createBindGroupLayout({
    entries: [
        {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {
              sampleType: 'unfilterable-float',
              viewDimension: '3d'
            }
          }
    ]
});
    return [offscreenShaderModule, vertexBufferLayout, uniformsBindGroupLayout, textureBindGroupLayout];
}

// First, calculate the size of the uniform buffer
// Note: WebGPU requires buffers to be aligned to 16 bytes
const MATRIX_SIZE = 4 * 4 * 4; // 4x4 matrix of f32 (4 bytes each)
const VEC3_SIZE = 4 * 4;       // vec3 needs to be aligned to vec4 (16 bytes)
const F32_SIZE = 4;            // f32 is 4 bytes
const I32_SIZE = 4;            // i32 is 4 bytes

const uniformBufferSize = 
  MATRIX_SIZE * 3 +    // modelMatrix, viewMatrix, projectionMatrix
  VEC3_SIZE +          // cameraPosition (aligned to 16 bytes)
  F32_SIZE +           // stepSize
  I32_SIZE +           // maxSteps
  F32_SIZE +           // minValue
  F32_SIZE;            // maxValue
///creates the uniform buffer for the volume renderer
export function createBufferForVolumetricRender(device:GPUDevice):GPUBuffer{
    // Create the uniform buffer
    const uniformBuffer = device.createBuffer({
        size: uniformBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return uniformBuffer;
}
/** Uniform buffer data structure for WebGPU shader */
export type VolumetricUniforms = {
    /** 4x4 model transformation matrix */
    modelMatrix: Float32Array;
    /** 4x4 view transformation matrix */
    viewMatrix: Float32Array;
    /** 4x4 projection transformation matrix */
    projectionMatrix: Float32Array;
    /** Camera position vector (should be 3 components) */
    cameraPosition: Float32Array;
    /** Size of each ray marching step */
    stepSize: number;
    /** Maximum number of ray marching steps */
    maxSteps: number;
    /** Minimum value for range */
    minValue: number;
    /** Maximum value for range */
    maxValue: number;
  };
// Function to upload data to the uniform buffer
export function uploadToUniformBuffer(device: GPUDevice, uniformBuffer: GPUBuffer, uniforms: VolumetricUniforms) {
    // Create array buffer with the correct size
    const arrayBuffer = new ArrayBuffer(uniformBufferSize);
    const dataView = new DataView(arrayBuffer);
    let offset = 0;
  
    // Helper function to copy Float32Array data
    function copyMatrix(matrix: Float32Array) {
      for (let i = 0; i < matrix.length; i++) {
        dataView.setFloat32(offset + i * 4, matrix[i], true); // true for little-endian
      }
      offset += matrix.length * 4;
    }
  
    // Copy matrices
    copyMatrix(uniforms.modelMatrix);
    copyMatrix(uniforms.viewMatrix);
    copyMatrix(uniforms.projectionMatrix);
    
    // Copy camera position (vec3 aligned to vec4)
    for (let i = 0; i < 3; i++) {
      dataView.setFloat32(offset + i * 4, uniforms.cameraPosition[i], true);
    }
    offset += VEC3_SIZE; // Skip to next 16-byte aligned position
  
    // Copy other values
    dataView.setFloat32(offset, uniforms.stepSize, true);
    offset += F32_SIZE;
    
    dataView.setInt32(offset, uniforms.maxSteps, true);
    offset += I32_SIZE;
    
    dataView.setFloat32(offset, uniforms.minValue, true);
    offset += F32_SIZE;
    
    dataView.setFloat32(offset, uniforms.maxValue, true);
  
    // Write the data to the buffer
    device.queue.writeBuffer(uniformBuffer, 0, arrayBuffer);
  }