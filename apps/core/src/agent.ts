import type {
  AgentRequest,
  AgentResponse,
  ModelProvider,
} from "@starfire/contracts";

export class Agent {
  constructor(private readonly model: ModelProvider) {}

  async handle(request: AgentRequest): Promise<AgentResponse> {
    const response = await this.model.generate({
      user: request.text,
    });

    if (response.type === "text") {
      return {
        requestId: request.id,
        text: response.text,
      };
    }

    throw new Error("Tool execution is not implemented yet");
  }
}
