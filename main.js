var d = require("obsidian");

var TAB_COLORS = [
  { name: "Red", value: "#e74c3c" },
  { name: "Orange", value: "#e67e22" },
  { name: "Yellow", value: "#f1c40f" },
  { name: "Green", value: "#27ae60" },
  { name: "Blue", value: "#3498db" },
  { name: "Purple", value: "#9b59b6" },
  { name: "Pink", value: "#e84393" }
];

class TabRenamePlugin extends d.Plugin {
  constructor() {
    super(...arguments);
    this.customTitles = {};
    this.tabColors = {};
    this.pendingLeaf = null;
    this.origShowAtMouseEvent = null;
    this.origShowAtPosition = null;
  }

  async onload() {
    var saved = await this.loadData();
    if (saved) {
      if (saved.customTitles) this.customTitles = saved.customTitles;
      if (saved.tabColors) this.tabColors = saved.tabColors;
    }

    var plugin = this;

    // === FILE TABS: use Obsidian's file-menu event (already works) ===
    this.registerEvent(
      this.app.workspace.on("file-menu", function (menu, file, source, leaf) {
        if (!(file instanceof d.TFile)) return;

        menu.addItem(function (item) {
          item.setTitle("Rename file").setIcon("pencil").setSection("action").onClick(function () {
            plugin.promptFileRename(file);
          });
        });

        if (leaf) {
          plugin.addTabMenuItems(menu, leaf);
        }
      })
    );

    // === NON-FILE TABS: set pendingLeaf on right-click (no blocking!) ===
    this.registerDomEvent(document, "contextmenu", function (evt) {
      var tabHeader = evt.target.closest(".workspace-tab-header");
      if (!tabHeader) return;

      var leaf = plugin.findLeafByTabHeader(tabHeader);
      if (!leaf) return;

      // Skip file tabs — handled by file-menu above
      if (leaf.view && leaf.view.file) return;

      // Just set the pending leaf — don't block the event
      plugin.pendingLeaf = leaf;
    });

    // === MONKEY-PATCH Menu.prototype.showAtMouseEvent ===
    // Inject our items into ANY menu right before it renders.
    // addItem() "only works when menu is not shown yet" — perfect timing.
    this.origShowAtMouseEvent = d.Menu.prototype.showAtMouseEvent;
    d.Menu.prototype.showAtMouseEvent = function (evt) {
      if (plugin.pendingLeaf) {
        plugin.addTabMenuItems(this, plugin.pendingLeaf);
        plugin.pendingLeaf = null;
      }
      return plugin.origShowAtMouseEvent.call(this, evt);
    };

    // Also patch showAtPosition as fallback
    this.origShowAtPosition = d.Menu.prototype.showAtPosition;
    d.Menu.prototype.showAtPosition = function (position, doc) {
      if (plugin.pendingLeaf) {
        plugin.addTabMenuItems(this, plugin.pendingLeaf);
        plugin.pendingLeaf = null;
      }
      return plugin.origShowAtPosition.call(this, position, doc);
    };

    // === Commands ===
    this.addCommand({
      id: "rename-active-tab",
      name: "Rename active tab",
      callback: function () {
        var leaf = plugin.app.workspace.activeLeaf;
        if (leaf) plugin.promptTabRename(leaf);
      }
    });

    // Apply saved titles and colors
    this.app.workspace.onLayoutReady(function () { plugin.applyAll(); });
    this.registerEvent(this.app.workspace.on("layout-change", function () { plugin.applyAll(); }));
  }

  // Adds Rename tab + Tab color to an Obsidian Menu object
  addTabMenuItems(menu, leaf) {
    var plugin = this;

    menu.addSeparator();

    menu.addItem(function (item) {
      item.setTitle("Rename tab").setIcon("pencil").onClick(function () {
        plugin.promptTabRename(leaf);
      });
    });

    menu.addItem(function (item) {
      item.setTitle("Tab color").setIcon("palette");
      var sub = item.setSubmenu();
      for (var i = 0; i < TAB_COLORS.length; i++) {
        (function (color) {
          sub.addItem(function (si) {
            si.setTitle(color.name).onClick(function () {
              plugin.setTabColor(leaf, color.value);
            });
          });
        })(TAB_COLORS[i]);
      }
      if (plugin.tabColors[leaf.id]) {
        sub.addSeparator();
        sub.addItem(function (si) {
          si.setTitle("None").setIcon("x").onClick(function () {
            plugin.clearTabColor(leaf);
          });
        });
      }
    });
  }

  findLeafByTabHeader(tabHeaderEl) {
    var found = null;
    this.app.workspace.iterateAllLeaves(function (leaf) {
      if (found) return;
      if (leaf.tabHeaderEl === tabHeaderEl) {
        found = leaf;
      }
    });
    return found;
  }

  // --- Rename ---

  promptFileRename(file) {
    new RenameModal(this.app, "Rename file", file.basename, async function (newName) {
      if (!newName || newName === file.basename) return;
      var newPath = file.parent
        ? file.parent.path + "/" + newName + "." + file.extension
        : newName + "." + file.extension;
      if (this.app.vault.getAbstractFileByPath(newPath)) {
        new d.Notice("A file with that name already exists.");
        return;
      }
      await this.app.fileManager.renameFile(file, newPath);
      new d.Notice("Renamed to " + newName);
    }.bind(this)).open();
  }

  promptTabRename(leaf) {
    var plugin = this;
    var current = this.customTitles[leaf.id] || leaf.getDisplayText();
    new RenameModal(this.app, "Rename tab", current, async function (newTitle) {
      if (!newTitle) return;
      plugin.customTitles[leaf.id] = newTitle;
      await plugin.persist();
      plugin.applyCustomTitle(leaf);
      new d.Notice("Tab renamed to " + newTitle);
    }).open();
  }

  resetTabTitle(leaf) {
    delete this.customTitles[leaf.id];
    this.persist();
    if (leaf.view && leaf.view._origGetDisplayText) {
      leaf.view.getDisplayText = leaf.view._origGetDisplayText;
      delete leaf.view._origGetDisplayText;
    }
    leaf.updateHeader();
    new d.Notice("Tab name reset");
  }

  applyCustomTitle(leaf) {
    var title = this.customTitles[leaf.id];
    if (!title || !leaf.view) return;
    if (!leaf.view._origGetDisplayText) {
      leaf.view._origGetDisplayText = leaf.view.getDisplayText.bind(leaf.view);
    }
    leaf.view.getDisplayText = function () { return title; };
    leaf.updateHeader();
  }

  // --- Colors ---

  setTabColor(leaf, color) {
    this.tabColors[leaf.id] = color;
    this.persist();
    this.applyTabColor(leaf);
    new d.Notice("Tab color set");
  }

  clearTabColor(leaf) {
    delete this.tabColors[leaf.id];
    this.persist();
    if (leaf.tabHeaderEl) {
      leaf.tabHeaderEl.style.removeProperty("--tab-color");
      leaf.tabHeaderEl.classList.remove("has-tab-color");
    }
    new d.Notice("Tab color removed");
  }

  applyTabColor(leaf) {
    var color = this.tabColors[leaf.id];
    if (!color || !leaf.tabHeaderEl) return;
    leaf.tabHeaderEl.style.setProperty("--tab-color", color);
    leaf.tabHeaderEl.classList.add("has-tab-color");
  }

  // --- Apply all ---

  applyAll() {
    var plugin = this;
    this.app.workspace.iterateAllLeaves(function (leaf) {
      if (plugin.customTitles[leaf.id]) plugin.applyCustomTitle(leaf);
      if (plugin.tabColors[leaf.id]) plugin.applyTabColor(leaf);
    });
  }

  persist() {
    return this.saveData({ customTitles: this.customTitles, tabColors: this.tabColors });
  }

  onunload() {
    // Restore original Menu methods
    if (this.origShowAtMouseEvent) {
      d.Menu.prototype.showAtMouseEvent = this.origShowAtMouseEvent;
    }
    if (this.origShowAtPosition) {
      d.Menu.prototype.showAtPosition = this.origShowAtPosition;
    }

    // Restore patched views
    this.app.workspace.iterateAllLeaves(function (leaf) {
      if (leaf.view && leaf.view._origGetDisplayText) {
        leaf.view.getDisplayText = leaf.view._origGetDisplayText;
        delete leaf.view._origGetDisplayText;
      }
      if (leaf.tabHeaderEl) {
        leaf.tabHeaderEl.style.removeProperty("--tab-color");
        leaf.tabHeaderEl.classList.remove("has-tab-color");
      }
    });
  }
}

class RenameModal extends d.Modal {
  constructor(app, title, currentName, onSubmit) {
    super(app);
    this.title = title;
    this.currentName = currentName;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.contentEl.createEl("h3", { text: this.title });
    this.inputEl = this.contentEl.createEl("input", { type: "text", value: this.currentName });
    this.inputEl.style.cssText = "width:100%;padding:8px;font-size:14px;margin-bottom:12px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal)";
    var self = this;
    setTimeout(function () { self.inputEl.focus(); self.inputEl.select(); }, 10);
    this.inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); self.submit(); }
      if (e.key === "Escape") { self.close(); }
    });
    var btns = this.contentEl.createDiv();
    btns.style.cssText = "display:flex;justify-content:flex-end;gap:8px";
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", function () { self.close(); });
    btns.createEl("button", { text: "Rename", cls: "mod-cta" }).addEventListener("click", function () { self.submit(); });
  }

  submit() { this.onSubmit(this.inputEl.value.trim()); this.close(); }
  onClose() { this.contentEl.empty(); }
}

module.exports = TabRenamePlugin;
