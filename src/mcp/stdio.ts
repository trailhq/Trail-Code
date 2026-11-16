/** A disconnected MCP host is a normal end of a stdio session. */
export function handleMcpStdoutError(error: NodeJS.ErrnoException): void {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
}
