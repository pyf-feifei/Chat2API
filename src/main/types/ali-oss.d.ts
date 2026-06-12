declare module 'ali-oss' {
  interface OSSOptions {
    accessKeyId: string
    accessKeySecret: string
    bucket: string
    endpoint: string
    region?: string
    stsToken?: string
    authorizationV4?: boolean
  }

  interface PutResult {
    name: string
    url: string
    res: any
  }

  class OSS {
    constructor(options: OSSOptions)
    put(name: string, data: Buffer | string, options?: any): Promise<PutResult>
  }

  export default OSS
}
