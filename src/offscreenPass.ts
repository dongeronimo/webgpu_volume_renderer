export interface OffscreenPassOptions {
    device: GPUDevice;
    format: GPUTextureFormat;
    width: number;
    height: number;
    sampleCount?: number;
}

export class OffscreenPass {
    private device: GPUDevice;
    private format: GPUTextureFormat;
    private width: number;
    private height: number;
    private sampleCount: number;

    private msaaTexture: GPUTexture|undefined;
    private resolveTexture: GPUTexture|undefined;

    constructor({ 
        device, 
        format, 
        width, 
        height, 
        sampleCount = 4 
    }: OffscreenPassOptions) {
        this.device = device;
        this.format = format;
        this.width = width;
        this.height = height;
        this.sampleCount = sampleCount;

        this.createTextures();
    }
    private msaaTextureView:GPUTextureView|undefined;
    private resolveTextureView:GPUTextureView|undefined;
    private depthTexture:GPUTexture|undefined;
    private depthView:GPUTextureView|undefined;
    private createTextures(): void {
        // Create multisampled texture
        this.msaaTexture = this.device.createTexture({
            size: [this.width, this.height],
            format: this.format,
            sampleCount: this.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.msaaTexture.label = "msaaTexture";

        // Create resolve texture
        this.resolveTexture = this.device.createTexture({
            size: [this.width, this.height],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.resolveTexture.label = "resolveTexture";
        this.msaaTextureView = this.msaaTexture.createView();
        this.resolveTextureView = this.resolveTexture.createView();
        // Create depth texture
        this.depthTexture = this.device.createTexture({
            size: {
                width: this.width,
                height: this.height,
                depthOrArrayLayers: 1
            },
            format: 'depth24plus',
            // sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTexture.label = "depthBuffer";
        // Create depth texture view
        this.depthView = this.depthTexture.createView();
        this.depthView.label = "depthBufferView";
    }

    public resize(width: number, height: number): void {
        // Only resize if dimensions actually changed
        if (this.width === width && this.height === height) {
            return;
        }

        // Destroy old textures
        this.msaaTexture!.destroy();
        this.resolveTexture!.destroy();

        // Update dimensions
        this.width = width;
        this.height = height;
        console.log("resize?");
        // Create new textures
        this.createTextures();

    }

    public beginPass(
        commandEncoder: GPUCommandEncoder,
        clearColor: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 }
    ): GPURenderPassEncoder {
        return commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.resolveTextureView!,
                // resolveTarget: this.resolveTextureView!,
                clearValue: clearColor,
                loadOp: 'clear',
                storeOp: 'store'
            }],
            depthStencilAttachment: {
                view: this.depthView!, 
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            }
        });
    }

    public getResolveTexture(): GPUTexture {
        return this.resolveTexture!;
    }

    public getResolveTextureView(): GPUTextureView {
        return this.resolveTexture!.createView();
    }

    public getMSAATexture(): GPUTexture {
        return this.msaaTexture!;
    }

    public getMSAATextureView(): GPUTextureView {
        return this.msaaTexture!.createView();
    }

    public destroy(): void {
        this.msaaTexture!.destroy();
        this.resolveTexture!.destroy();
    }
}