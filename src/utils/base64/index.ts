export function escape(string: string) {
  return string
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export function toBase64(input: Buffer) {
  return escape(input.toString('base64'))
}
