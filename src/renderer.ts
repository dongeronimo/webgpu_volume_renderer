import { WebgpuContext } from "./webgpuContext";

export class WebgpuRenderer {
    private readonly ctx:WebgpuContext;
    private lastFrameTime: number = 0;
    private deltaTime: number = 0;
    public onUpdate?:(currentTime:number, commandEncoder:GPUCommandEncoder)=>void;
    public onRender?:(commandEncoder:GPUCommandEncoder)=>void
    constructor(ctx:WebgpuContext){
        this.ctx = ctx;
    }
    private updateTime(currentTime:number):number {
        currentTime *= 0.001;
        this.deltaTime = currentTime - this.lastFrameTime;
        this.lastFrameTime = currentTime;
        return currentTime;
    }
    public render(currentTime:number){
        currentTime = this.updateTime(currentTime);
        const commandEncoder:GPUCommandEncoder = this.ctx.Device().createCommandEncoder();
        if(this.onUpdate)
            this.onUpdate(currentTime, commandEncoder);
        if(this.onRender)
            this.onRender(commandEncoder);
        this.ctx.UsePresentationPass(commandEncoder);
        this.ctx.Device().queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(this.render.bind(this));
    }
}