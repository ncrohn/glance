export function confirmReload(fileName: string): Promise<"mine" | "disk"> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root")!;
    root.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const box = document.createElement("div");
    box.className = "box";
    box.innerHTML = `<p><strong>${fileName}</strong> changed on disk while you have unsaved edits.</p>`;
    const keep = document.createElement("button");
    keep.textContent = "Keep mine";
    const load = document.createElement("button");
    load.textContent = "Load disk";
    const done = (r: "mine" | "disk") => { root.innerHTML = ""; resolve(r); };
    keep.onclick = () => done("mine");
    load.onclick = () => done("disk");
    box.appendChild(keep); box.appendChild(load);
    overlay.appendChild(box); root.appendChild(overlay);
  });
}
