export class GPUMesh {
    public readonly vertexBuffer: GPUBuffer;
    public readonly indexBuffer: GPUBuffer;
    public readonly numberOfIndices:number;
    constructor(device:GPUDevice, vertexBufferData:Float32Array, indexBufferData:Uint16Array, numberOfIndices:number){
        this.numberOfIndices = numberOfIndices;
        this.vertexBuffer = device.createBuffer({
            size: vertexBufferData.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(this.vertexBuffer, 0, vertexBufferData);
        this.indexBuffer = device.createBuffer({
            size: indexBufferData.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(this.indexBuffer, 0, indexBufferData);
    }
}