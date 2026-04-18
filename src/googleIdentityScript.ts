const SCRIPT_ID = "google-identity-services-script";
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

/** Reused while a load is in flight so concurrent callers await the same result. */
let inflight: Promise<void> | null = null;

export function loadGoogleIdentityScript(): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("loadGoogleIdentityScript requires a browser environment"));
  }

  if (inflight) {
    return inflight;
  }

  if (document.getElementById(SCRIPT_ID)) {
    return Promise.resolve();
  }

  inflight = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      inflight = null;
      resolve();
    };
    script.onerror = () => {
      inflight = null;
      script.remove();
      reject(new Error(`Failed to load Google Identity Services script: ${SCRIPT_SRC}`));
    };
    document.head.appendChild(script);
  });

  return inflight;
}
