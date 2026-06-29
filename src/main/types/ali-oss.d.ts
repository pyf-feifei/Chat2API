declare module 'ali-oss' {
  interface OSSOptions {
    accessKeyId: string
    accessKeySecret: string
    bucket: string
    endpoint: string
    region?: string
    stsToken?: string
    authorizationV4?: boolean
    timeout?: number
    retryMax?: number
  }

  interface PutResult {
    name: string
    url: string
    res: any
  }

  class OSS {
    constructor(options: OSSOptions)
    put(name: string, data: Buffer | string, options?: any): Promise<PutResult>
    multipartUpload(name: string, data: Buffer | string, options?: any): Promise<any>
  }

  export default OSS
}
