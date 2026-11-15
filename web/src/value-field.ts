/**
 * The value input (SPEC.md § Web UI, Values). Env-style names get one masked line, file-style names
 * multi-line text or a picked file. The value stays in this element and in memory only.
 */
import { secretKind } from "../../src/index.js";
import { h } from "./dom.js";
import { generateValue, MAX_VALUE_BYTES } from "./write.js";

export interface ValueField {
  readonly element: HTMLElement;
  /** Re-renders for the kind of `name` (env or file). */
  setName(name: string): void;
  read(): Promise<Uint8Array>;
  clear(): void;
}

export function valueField(id: string): ValueField {
  let kind: "env" | "file" = "env";
  let file: File | undefined;

  const line = h("input", {
    id,
    type: "text",
    class: "value-input masked",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "aria-describedby": `${id}-hint`,
  });
  const text = h("textarea", {
    id: `${id}-text`,
    class: "value-input masked",
    rows: "6",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "aria-describedby": `${id}-hint`,
    hidden: true,
  });
  const fileName = h("span", { class: "file-name" });
  const picker = h("input", {
    type: "file",
    class: "visually-hidden",
    id: `${id}-file`,
    onchange: () => {
      file = picker.files?.[0];
      text.disabled = file !== undefined;
      fileName.textContent =
        file === undefined ? "" : `${file.name} · ${formatSize(file.size)} · exact bytes`;
      clearFile.hidden = file === undefined;
      hint.textContent =
        file !== undefined && file.size > MAX_VALUE_BYTES
          ? "Larger than 1 MiB: too big."
          : hintText();
    },
  });
  const clearFile = h(
    "button",
    {
      type: "button",
      class: "link-button",
      hidden: true,
      onclick: () => {
        picker.value = "";
        picker.dispatchEvent(new Event("change"));
      },
    },
    "Remove file",
  );
  const fileRow = h(
    "div",
    { class: "file-row", hidden: true },
    picker,
    h("label", { for: `${id}-file`, class: "button button-quiet" }, "Use a file"),
    fileName,
    clearFile,
  );

  const reveal = h("input", {
    type: "checkbox",
    id: `${id}-reveal`,
    onchange: () => {
      line.classList.toggle("masked", !reveal.checked);
      text.classList.toggle("masked", !reveal.checked);
    },
  });
  const hint = h("p", { class: "hint", id: `${id}-hint` });
  const hintText = (): string =>
    kind === "env"
      ? "One line, stored exactly as typed. Never leaves this device unencrypted."
      : "Text or a file, stored as exact bytes. Never leaves this device unencrypted.";

  const generate = h(
    "button",
    {
      type: "button",
      class: "button button-quiet",
      onclick: () => {
        const value = generateValue();
        if (kind === "env") line.value = value;
        else text.value = value;
        hint.textContent = "Filled in a random value: 32 bytes, base64url.";
      },
    },
    "Generate",
  );

  const element = h(
    "div",
    { class: "value-field" },
    h(
      "div",
      { class: "field-head" },
      h("label", { for: id, class: "label" }, "Value"),
      h("label", { class: "reveal" }, reveal, " Show"),
    ),
    line,
    text,
    h("div", { class: "value-actions" }, fileRow, generate),
    hint,
  );

  const setName = (name: string): void => {
    kind = secretKind(name) === "file" ? "file" : "env";
    line.hidden = kind !== "env";
    text.hidden = kind !== "file";
    fileRow.hidden = kind !== "file";
    const label = element.querySelector<HTMLLabelElement>(
      `label[for="${id}"], label[for="${id}-text"]`,
    );
    label?.setAttribute("for", kind === "env" ? id : `${id}-text`);
    hint.textContent = hintText();
  };
  setName("");

  return {
    element,
    setName,
    async read() {
      if (kind === "env") return new TextEncoder().encode(line.value);
      if (file !== undefined) return new Uint8Array(await file.arrayBuffer());
      return new TextEncoder().encode(text.value);
    },
    clear() {
      line.value = "";
      text.value = "";
      picker.value = "";
      file = undefined;
      text.disabled = false;
      fileName.textContent = "";
      clearFile.hidden = true;
      reveal.checked = false;
      line.classList.add("masked");
      text.classList.add("masked");
      hint.textContent = hintText();
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
