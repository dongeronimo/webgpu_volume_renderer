// packInterleaved.ts

export function packInterleaved(
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array
  ): Float32Array {
    const vertexCount = positions.length / 3; // Assuming 3 components per vertex
    const stride = 3 + 3 + 2; // Position(3) + Normal(3) + UV(2)
  
    const interleavedData = new Float32Array(vertexCount * stride);
  
    for (let i = 0; i < vertexCount; i++) {
      const posOffset = i * 3;
      const normalOffset = i * 3;
      const uvOffset = i * 2;
      const interleavedOffset = i * stride;
  
      // Write position
      interleavedData[interleavedOffset] = positions[posOffset];
      interleavedData[interleavedOffset + 1] = positions[posOffset + 1];
      interleavedData[interleavedOffset + 2] = positions[posOffset + 2];
  
      // Write normal
      interleavedData[interleavedOffset + 3] = normals[normalOffset];
      interleavedData[interleavedOffset + 4] = normals[normalOffset + 1];
      interleavedData[interleavedOffset + 5] = normals[normalOffset + 2];
  
      // Write UV
      interleavedData[interleavedOffset + 6] = uvs[uvOffset];
      interleavedData[interleavedOffset + 7] = uvs[uvOffset + 1];
    }
  
    return interleavedData;
  }
  