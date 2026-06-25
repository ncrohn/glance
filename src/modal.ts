export function confirmReload(fileName: string): Promise<"mine" | "disk"> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root")!;
    root.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const box = document.createElement("div");
    box.className = "box";
    const msg = document.createElement("p");
    const name = document.createElement("strong");
    name.textContent = fileName;
    msg.appendChild(name);
    msg.appendChild(document.createTextNode(" changed on disk while you have unsaved edits."));
    box.appendChild(msg);
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

export function showNotice(message: string, ok = true): void {
  const root = document.getElementById("modal-root")!;
  root.innerHTML = "";
  const overlay = document.createElement("div");
  overlay.className = "modal";
  const box = document.createElement("div");
  box.className = ok ? "box" : "box error";
  const msg = document.createElement("p");
  msg.textContent = ok ? message : `⚠️ ${message}`;
  box.appendChild(msg);
  const okBtn = document.createElement("button");
  okBtn.textContent = "OK";
  okBtn.onclick = () => { root.innerHTML = ""; };
  box.appendChild(okBtn);
  overlay.appendChild(box); root.appendChild(overlay);
}
