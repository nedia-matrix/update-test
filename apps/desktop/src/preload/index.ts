import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "@nedia-matrix/desktop-client/api-client";

contextBridge.exposeInMainWorld("matrix", createDesktopApi(ipcRenderer));
