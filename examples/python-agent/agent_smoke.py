from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


resource = Resource.create({"service.name": "python-agent-smoke"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("python-agent-smoke")

with tracer.start_as_current_span("agent.plan") as span:
    span.set_attribute("gen_ai.system", "openai")
    span.set_attribute("gen_ai.request.model", "gpt-4.1")
    span.set_attribute("gen_ai.usage.input_tokens", 120)
    span.set_attribute("gen_ai.usage.output_tokens", 35)

with tracer.start_as_current_span("vector retrieval") as span:
    span.set_attribute("openinference.span.kind", "retriever")
    span.set_attribute("retrieval.documents.0.id", "py-doc-1")
    span.set_attribute("retrieval.documents.0.title", "Python smoke document")
    span.set_attribute("retrieval.documents.0.score", 0.91)
    span.set_attribute("retrieval.documents.0.content", "The local workbench receives OTLP telemetry from Python agents.")

provider.force_flush()
provider.shutdown()
print("sent python-agent-smoke trace")
