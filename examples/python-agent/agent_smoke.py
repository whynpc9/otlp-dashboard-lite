import os
from pathlib import Path

from dotenv import load_dotenv
from opentelemetry._logs import set_logger_provider
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.langchain import LangchainInstrumentor
from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def load_nearest_dotenv() -> None:
    current = Path(__file__).resolve().parent
    for directory in [current, *current.parents]:
        candidate = directory / ".env"
        if candidate.exists():
            load_dotenv(candidate)
            return


load_nearest_dotenv()

os.environ.setdefault("OTEL_SERVICE_NAME", "python-langchain-deepseek")
os.environ.setdefault("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true")

if not os.environ.get("DEEPSEEK_API_KEY"):
    raise RuntimeError("DEEPSEEK_API_KEY is required. Put it in .env or export it before running this example.")

resource = Resource.create({"service.name": os.environ["OTEL_SERVICE_NAME"]})
provider = TracerProvider(resource=resource)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
set_logger_provider(logger_provider)

LangchainInstrumentor().instrument()
OpenAIInstrumentor().instrument()

from langchain_core.messages import HumanMessage, SystemMessage  # noqa: E402
from langchain_openai import ChatOpenAI  # noqa: E402


tracer = trace.get_tracer("python-langchain-deepseek")

with tracer.start_as_current_span("langchain.deepseek.validation") as span:
    llm = ChatOpenAI(
        model=os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
        api_key=os.environ["DEEPSEEK_API_KEY"],
        base_url=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        temperature=0,
        max_tokens=80,
    )

    response = llm.invoke(
        [
            SystemMessage(content="You are validating OpenTelemetry GenAI instrumentation. Answer in one short sentence."),
            HumanMessage(content="Say that the Python LangChain DeepSeek telemetry probe succeeded."),
        ]
    )

    response_text = str(response.content).strip()
    span.set_attribute("validation.framework", "langchain")
    span.set_attribute("validation.provider", "deepseek")
    span.set_attribute("validation.response.length", len(response_text))

provider.force_flush()
logger_provider.force_flush()
provider.shutdown()
logger_provider.shutdown()

print("DeepSeek response:", response_text)
print("sent python-langchain-deepseek trace")
print("expected telemetry: LangChain spans plus OpenAI-compatible GenAI spans when OpenAI v2 instrumentation sees the DeepSeek call")
