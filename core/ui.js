/* Shared details hints, kept above scrolling panels. */
(() => {
  "use strict";
  let nextId = 0;
  const hints = new WeakMap();
  function replaceChildren(element, ...children) {
    const nodes = children.map((child) => typeof child === "string" ? document.createTextNode(child) : child);
    if (element.childNodes.length === nodes.length
      && nodes.every((node, index) => node.isEqualNode(element.childNodes[index]))) return;
    element.replaceChildren(...nodes);
  }
  function setHelp(button, text) {
    let hint = hints.get(button);
    if (!hint) {
      hint = document.createElement("div");
      hint.id = button.getAttribute("aria-describedby") || `detail-hint-${++nextId}`;
      hint.className = "help-tip"; hint.setAttribute("role", "tooltip"); hint.setAttribute("popover", "manual");
      document.body.append(hint); button.setAttribute("aria-describedby", hint.id); hints.set(button, hint);
      let timer;
      const hide = () => { clearTimeout(timer); hint.hidePopover(); };
      const show = () => {
        clearTimeout(timer); hint.showPopover();
        const rect = button.getBoundingClientRect();
        hint.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - hint.offsetWidth - 12))}px`;
        hint.style.top = `${rect.bottom + hint.offsetHeight + 20 < innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - hint.offsetHeight - 8)}px`;
      };
      const leave = () => { timer = setTimeout(() => {
        if (document.activeElement !== button && !button.matches(":hover") && !hint.matches(":hover")) hide();
      }, 120); };
      button.addEventListener("pointerenter", show); button.addEventListener("focus", show);
      button.addEventListener("pointerleave", leave); button.addEventListener("blur", leave);
      button.addEventListener("click", show);
      button.addEventListener("keydown", (event) => { if (event.key === "Escape") { hide(); event.stopPropagation(); } });
      hint.addEventListener("pointerenter", () => clearTimeout(timer)); hint.addEventListener("pointerleave", leave);
      window.addEventListener("resize", hide); window.addEventListener("scroll", hide, true);
    }
    replaceChildren(hint, text);
  }
  globalThis.DTWUI = Object.freeze({ setHelp, replaceChildren });
  for (const button of document.querySelectorAll("[data-help]")) setHelp(button, button.dataset.help);
  for (const menu of document.querySelectorAll(".menu")) {
    menu.addEventListener("click", (event) => { if (event.target.closest("button")) menu.open = false; });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); }
    });
    document.addEventListener("click", (event) => { if (!menu.contains(event.target)) menu.open = false; });
  }
})();
