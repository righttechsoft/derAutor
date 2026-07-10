// electron-vite emits assets imported with the `?asset` suffix and rewrites the
// import to the on-disk path (works in dev and in the packaged app).
declare module '*?asset' {
  const src: string
  export default src
}
