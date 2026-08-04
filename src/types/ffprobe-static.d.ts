// ffprobe-static@3 ships no type declarations; module.exports = { path, version }.
declare module "ffprobe-static" {
  const ffprobe: { path: string; version?: string };
  export default ffprobe;
}
