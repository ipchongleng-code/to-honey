/*
 * Eating Manager 前端配置
 * visionEndpoint：拍照识别接口地址。
 *   '/vision'：网页和 server.js 在同一个地方运行时用这个（本地测试、自己的服务器都是）。
 *   留空 ''：拍照识别使用演示数据。
 * 注意：API 密钥永远不要写在这里，这个文件任何人都能看到。
 */
window.EM_CONFIG = {
  visionEndpoint: '/vision'
};
