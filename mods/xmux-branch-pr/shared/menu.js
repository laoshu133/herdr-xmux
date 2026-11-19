// Generated from lib/xmux/menu.js. Run node scripts/sync-common.mjs.
// The one popup open at a time, shared by every chooser in the panel.
export function menuMethods(Select) {
  return {
    chooser({ id, choices, value, onChoose, triggerFocus, ...rest }) {
      const enabled = choices.filter((c) => !c.disabled);
      return Select({
        id,
        choices,
        value,
        triggerFocus,
        ...rest,
        open: this.openMenu === id,
        index: this.menuIndex ?? 0,
        focus: this.menuFocus,
        onOpenChange: (open, cx) => {
          this.openMenu = open ? id : null;
          this.menuIndex = Math.max(
            0,
            enabled.findIndex((c) => c.id === value),
          );
          cx.notify();
        },
        onMove: (index, cx) => {
          this.menuIndex = index;
          cx.notify();
        },
        onChoose: (choice, cx) => {
          this.openMenu = null;
          onChoose(choice.id, cx);
          triggerFocus?.focus();
          cx.notify();
        },
      });
    },
  };
}
