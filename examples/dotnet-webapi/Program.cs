using System.Diagnostics;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);
var serviceName = Environment.GetEnvironmentVariable("OTEL_SERVICE_NAME") ?? "dotnet-webapi-smoke";
var activitySource = new ActivitySource(serviceName);

builder.Services.AddSingleton(activitySource);
builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource.AddService(serviceName))
    .WithTracing(tracing => tracing
        .AddSource(serviceName)
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter())
    .WithMetrics(metrics => metrics
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter());

builder.Logging.AddOpenTelemetry(logging =>
{
    logging.IncludeFormattedMessage = true;
    logging.IncludeScopes = true;
    logging.ParseStateValues = true;
    logging.SetResourceBuilder(ResourceBuilder.CreateDefault().AddService(serviceName));
    logging.AddOtlpExporter();
});

var app = builder.Build();

app.MapGet("/", (ILoggerFactory loggerFactory, ActivitySource source) =>
{
    var logger = loggerFactory.CreateLogger("DotnetOtlpSmoke");
    using var activity = source.StartActivity("agent.request", ActivityKind.Internal);
    activity?.SetTag("gen_ai.system", "openai");
    activity?.SetTag("gen_ai.operation.name", "chat");
    activity?.SetTag("gen_ai.request.model", "gpt-4.1-mini");
    activity?.SetTag("gen_ai.usage.input_tokens", 42);
    activity?.SetTag("gen_ai.usage.output_tokens", 16);
    activity?.SetTag("gen_ai.prompt", "Explain the local OTLP workbench smoke test.");
    activity?.SetTag("gen_ai.completion", "The dashboard received trace, log, and metric data.");

    logger.LogInformation("Handled .NET OTLP smoke request with trace {TraceId}", Activity.Current?.TraceId.ToString());
    return Results.Ok(new
    {
        ok = true,
        service = serviceName,
        traceId = Activity.Current?.TraceId.ToString()
    });
});

app.Run();
