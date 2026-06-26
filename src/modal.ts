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

// Native window.prompt() is a no-op in the macOS WKWebview Tauri uses, so we
// roll our own text-input modal (same overlay machinery as confirmReload).
// Resolves with the trimmed text, or null if cancelled / left empty.
export function promptText(label: string, placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root")!;
    root.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const box = document.createElement("div");
    box.className = "box";
    const msg = document.createElement("p");
    msg.textContent = label;
    box.appendChild(msg);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "modal-input";
    input.placeholder = placeholder;
    box.appendChild(input);
    const save = document.createElement("button");
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const done = (r: string | null) => { root.innerHTML = ""; resolve(r); };
    const submit = () => { const v = input.value.trim(); done(v ? v : null); };
    save.onclick = submit;
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    };
    box.appendChild(save); box.appendChild(cancel);
    overlay.appendChild(box); root.appendChild(overlay);
    input.focus();
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
