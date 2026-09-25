const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("starfireDesktop", {
  isElectron: true,
});
