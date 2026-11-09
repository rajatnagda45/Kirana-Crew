/**
 * Browser actions for a report: copy, download and print. Each returns whether it worked so the
 * view can say so; none throws.
 */

/** Copies text. Uses the clipboard API, with a textarea fallback for pages that are not secure contexts. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the fallback */
  }
  try {
    const box = document.createElement("textarea");
    box.value = value;
    box.setAttribute("readonly", "");
    box.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(box);
    return ok;
  } catch {
    return false;
  }
}

export function downloadFile(
  name: string,
  content: string,
  type = "text/csv;charset=utf-8",
): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prints an HTML document from a hidden same-origin iframe. The iframe is full-page size and kept
 * off-screen (a zero-size frame can print blank in some browsers), prints once it has loaded, and
 * is removed after printing, with a timeout in case `afterprint` never fires.
 */
export function printHtmlDocument(html: string, { cleanupMs = 60_000 } = {}): boolean {
  try {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.title = "Report to print";
    frame.style.cssText =
      "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;visibility:visible";
    const remove = () => frame.parentNode?.removeChild(frame);
    frame.onload = () => {
      const view = frame.contentWindow;
      if (!view) return remove();
      view.addEventListener("afterprint", remove, { once: true });
      view.focus();
      view.print();
      setTimeout(remove, cleanupMs);
    };
    frame.srcdoc = html; // assigned as a property, never concatenated into markup
    document.body.appendChild(frame);
    return true;
  } catch {
    return false;
  }
}
