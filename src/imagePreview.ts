export async function generatePreviewBlob(
  original: Blob,
  maxSide = 384,
  mime = "image/jpeg",
  quality = 0.85
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const loadImage = (): Promise<ImageBitmap | HTMLImageElement> => {
      if (typeof createImageBitmap === "function") {
        return createImageBitmap(original);
      }
      return new Promise((res, rej) => {
        const img = new Image();
        const url = URL.createObjectURL(original);
        img.onload = () => {
          URL.revokeObjectURL(url);
          res(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          rej(new Error("Failed to load image"));
        };
        img.src = url;
      });
    };

    loadImage()
      .then((source) => {
        const width =
          "width" in source ? source.width : (source as HTMLImageElement).naturalWidth;
        const height =
          "height" in source ? source.height : (source as HTMLImageElement).naturalHeight;

        if (width <= 0 || height <= 0) {
          reject(new Error("Invalid image dimensions"));
          return;
        }

        const scale = Math.min(maxSide / width, maxSide / height, 1);
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2d not available"));
          return;
        }

        ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);

        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error("toBlob failed"));
          },
          mime,
          quality
        );
      })
      .catch(reject);
  });
}
