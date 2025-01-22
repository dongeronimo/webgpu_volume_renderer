import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    extensions: ['.js', '.ts']
  },
  esbuild: {
    loader: 'ts'
  }
});
