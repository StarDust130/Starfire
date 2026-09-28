/**
 * A user-friendly tool failure. The message goes back to the model,
 * so write it as something Starfire can say out loud.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);

    this.name = "ToolError";
  }
}
