import type { NetFuseApi } from './index'

declare global {
  interface Window {
    netfuse: NetFuseApi
  }
}
