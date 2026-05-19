using System.ClientModel;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using OpenAIChatClient = OpenAI.Chat.ChatClient;

LoadNearestDotEnv();

SetDefault("OTEL_SERVICE_NAME", "dotnet-meai-deepseek");
SetDefault("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true");

var serviceName = Environment.GetEnvironmentVariable("OTEL_SERVICE_NAME")!;
var apiKey = Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY");
if (string.IsNullOrWhiteSpace(apiKey))
{
    throw new InvalidOperationException("DEEPSEEK_API_KEY is required. Put it in .env or export it before running this example.");
}

using var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .SetResourceBuilder(ResourceBuilder.CreateDefault().AddService(serviceName))
    .AddSource(serviceName)
    .AddHttpClientInstrumentation()
    .AddOtlpExporter()
    .Build();

using var loggerFactory = LoggerFactory.Create(builder => builder.AddConsole());

var endpoint = new Uri(Environment.GetEnvironmentVariable("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com");
var model = Environment.GetEnvironmentVariable("DEEPSEEK_MODEL") ?? "deepseek-chat";
var openAiChatClient = new OpenAIChatClient(
    model,
    new ApiKeyCredential(apiKey),
    new OpenAI.OpenAIClientOptions { Endpoint = endpoint });

using IChatClient chatClient = new ChatClientBuilder(openAiChatClient.AsIChatClient())
    .UseOpenTelemetry(loggerFactory, sourceName: serviceName)
    .Build();

var response = await chatClient.GetResponseAsync(
    [
        new ChatMessage(ChatRole.System, "You are validating OpenTelemetry GenAI instrumentation. Answer in one short sentence."),
        new ChatMessage(ChatRole.User, "Say that the .NET Microsoft.Extensions.AI DeepSeek telemetry probe succeeded.")
    ],
    new ChatOptions
    {
        Temperature = 0,
        MaxOutputTokens = 80
    });

tracerProvider.ForceFlush();

Console.WriteLine($"DeepSeek response: {response.Text.Trim()}");
Console.WriteLine("sent dotnet-meai-deepseek trace");
Console.WriteLine("expected telemetry: Microsoft.Extensions.AI OpenTelemetryChatClient spans with GenAI semantic convention attributes");

static void SetDefault(string name, string value)
{
    if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)))
    {
        Environment.SetEnvironmentVariable(name, value);
    }
}

static void LoadNearestDotEnv()
{
    var current = new DirectoryInfo(AppContext.BaseDirectory);
    while (current is not null)
    {
        var candidate = Path.Combine(current.FullName, ".env");
        if (File.Exists(candidate))
        {
            foreach (var rawLine in File.ReadAllLines(candidate))
            {
                var line = rawLine.Trim();
                if (line.Length == 0 || line.StartsWith('#'))
                {
                    continue;
                }

                var separator = line.IndexOf('=');
                if (separator <= 0)
                {
                    continue;
                }

                var key = line[..separator].Trim();
                var value = line[(separator + 1)..].Trim().Trim('"').Trim('\'');
                if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key)))
                {
                    Environment.SetEnvironmentVariable(key, value);
                }
            }
            return;
        }
        current = current.Parent;
    }
}
