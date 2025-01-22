
export async function loadShader(filename:string):Promise<string> {
    try {
        const response = await fetch(`/shaders/${filename}`);
        if (!response.ok) {
            throw new Error(`Failed to load shader: ${response.statusText}`);
        }
        return await response.text();
    } catch (error) {
        console.error('Error loading shader ZZZZ:', error);
        throw error;
    }
}