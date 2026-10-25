const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onRlEvent: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('rl-event', handler);
    return () => ipcRenderer.removeListener('rl-event', handler);
  },
  onRlStatus: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('rl-status', handler);
    return () => ipcRenderer.removeListener('rl-status', handler);
  },
  onRlProcess: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('rl-process', handler);
    return () => ipcRenderer.removeListener('rl-process', handler);
  },
  startGoogleLogin: () => ipcRenderer.invoke('start-google-login'),
  onGoogleLoginResult: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('google-login-result', handler);
    return () => ipcRenderer.removeListener('google-login-result', handler);
  }
});
