// Network-free stand-in for axios, aliased in by the test. Records every call so
// a test can assert whether the refresher actually reached the network.
const calls = []
const record = (name) => (url, ...rest) => {
  calls.push({ name, url: String(url), opts: rest[0] || {} })
  return Promise.resolve({ status: 200, statusCode: 200, data: {}, headers: {} })
}
const client = (url, ...rest) => {
  calls.push({ name: 'request', url: String(url), opts: rest[0] || {} })
  return Promise.resolve({ status: 200, statusCode: 200, data: {}, headers: {} })
}
client.create = () => client
const post = record('post')
const get = record('get')
module.exports = { post, get, create: () => client, default: { post, get, create: () => client }, calls, __calls: calls }
