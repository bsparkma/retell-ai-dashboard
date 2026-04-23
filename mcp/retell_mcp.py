#!/usr/bin/env python3
"""
Retell AI MCP Server — CareIN AI / Bridge Dental AI

Provides full control over Retell AI via Claude:
  - Agent management (create, read, update, delete)
  - Phone call management (outbound calls, call logs, transcripts)
  - Phone number management (list, assign agents, import)
  - LLM / Response Engine management (prompts, tools, state machines)

Authentication:
  Set RETELL_API_KEY environment variable before running.
  export RETELL_API_KEY="your_api_key_here"

Usage:
  python retell_mcp.py

Add to Claude Desktop config (claude_desktop_config.json):
  {
    "mcpServers": {
      "retell": {
        "command": "python",
        "args": ["/path/to/retell_mcp.py"],
        "env": { "RETELL_API_KEY": "your_api_key_here" }
      }
    }
  }
"""

import json
import os
import sys
from typing import Any, Dict, List, Optional
from enum import Enum

import httpx
from pydantic import BaseModel, Field, ConfigDict
from mcp.server.fastmcp import FastMCP

# ─── Constants ────────────────────────────────────────────────────────────────

API_BASE_URL = "https://api.retellai.com"

def _get_api_key() -> str:
    key = os.environ.get("RETELL_API_KEY", "")
    if not key:
        print(
            "ERROR: RETELL_API_KEY environment variable not set.",
            file=sys.stderr
        )
    return key

# ─── Server Init ──────────────────────────────────────────────────────────────

mcp = FastMCP("retell_mcp")

# ─── Shared HTTP Client ───────────────────────────────────────────────────────

async def _api_request(
    method: str,
    path: str,
    body: Optional[Dict] = None,
    params: Optional[Dict] = None,
) -> Dict[str, Any]:
    """Central HTTP client for all Retell API calls."""
    api_key = _get_api_key()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = f"{API_BASE_URL}{path}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.request(
            method=method,
            url=url,
            headers=headers,
            json=body,
            params=params,
        )
        response.raise_for_status()
        if response.status_code == 204 or not response.content:
            return {"success": True}
        return response.json()


def _handle_error(e: Exception) -> str:
    """Return a clean, actionable error string."""
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        try:
            detail = e.response.json()
        except Exception:
            detail = e.response.text
        if code == 401:
            return "Error 401: Invalid API key. Check your RETELL_API_KEY environment variable."
        if code == 403:
            return "Error 403: Permission denied. Your API key may not have access to this resource."
        if code == 404:
            return f"Error 404: Resource not found. Double-check the ID. Detail: {detail}"
        if code == 429:
            return "Error 429: Rate limit exceeded. Wait a moment and try again."
        return f"Error {code}: {detail}"
    if isinstance(e, httpx.TimeoutException):
        return "Error: Request timed out. The Retell API may be slow — try again."
    return f"Error: {type(e).__name__}: {str(e)}"


# ─── Pydantic Input Models ─────────────────────────────────────────────────────

class ListAgentsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    limit: Optional[int] = Field(default=50, ge=1, le=200, description="Max agents to return (default 50)")


class GetAgentInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    agent_id: str = Field(..., description="The Retell agent ID (e.g., 'agent_abc123')", min_length=1)


class CreateAgentInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    agent_name: str = Field(..., description="Human-readable name (e.g., 'CareIN - Roland OK Front Desk')", min_length=1)
    llm_websocket_url: Optional[str] = Field(
        default=None,
        description="WebSocket URL for custom LLM. Use this OR response_engine_llm_id, not both."
    )
    response_engine_llm_id: Optional[str] = Field(
        default=None,
        description="Retell LLM ID to use as response engine. Use this OR llm_websocket_url."
    )
    voice_id: str = Field(
        default="11labs-Adrian",
        description="Voice ID for the agent (e.g., '11labs-Adrian', '11labs-Rachel')"
    )
    voice_model: Optional[str] = Field(
        default=None,
        description="Voice model override (e.g., 'eleven_turbo_v2')"
    )
    language: Optional[str] = Field(
        default="en-US",
        description="Agent language (e.g., 'en-US', 'es-US')"
    )
    webhook_url: Optional[str] = Field(
        default=None,
        description="HTTPS URL to receive call events (call_started, call_ended, call_analyzed)"
    )
    webhook_events: Optional[List[str]] = Field(
        default=None,
        description="List of events to send to webhook. Options: call_started, call_ended, call_analyzed"
    )
    ambient_sound: Optional[str] = Field(
        default=None,
        description="Background ambient sound (e.g., 'office', 'coffee-shop', 'convention-hall')"
    )
    enable_backchannel: Optional[bool] = Field(
        default=True,
        description="Enable conversational backchannels like 'mhm', 'got it' (default: true)"
    )
    interruption_sensitivity: Optional[float] = Field(
        default=None,
        ge=0.0, le=1.0,
        description="How sensitive to interruptions (0=ignore, 1=very sensitive)"
    )
    responsiveness: Optional[float] = Field(
        default=None,
        ge=0.0, le=1.0,
        description="How quickly agent responds (0=slow/thoughtful, 1=fast)"
    )
    end_call_after_silence_ms: Optional[int] = Field(
        default=None,
        ge=1000,
        description="Milliseconds of silence before hanging up (e.g., 30000 for 30 seconds)"
    )
    max_call_duration_ms: Optional[int] = Field(
        default=None,
        description="Max call duration in ms (e.g., 3600000 for 1 hour)"
    )
    post_call_analysis_data: Optional[List[Dict]] = Field(
        default=None,
        description="List of post-call analysis fields to extract (e.g., call reason, appointment booked)"
    )


class UpdateAgentInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    agent_id: str = Field(..., description="The agent ID to update", min_length=1)
    agent_name: Optional[str] = Field(default=None, description="New name for the agent")
    llm_websocket_url: Optional[str] = Field(default=None, description="New WebSocket LLM URL")
    response_engine_llm_id: Optional[str] = Field(default=None, description="New Retell LLM ID")
    voice_id: Optional[str] = Field(default=None, description="New voice ID")
    language: Optional[str] = Field(default=None, description="New language (e.g., 'es-US')")
    webhook_url: Optional[str] = Field(default=None, description="New webhook URL")
    webhook_events: Optional[List[str]] = Field(default=None, description="New webhook event list")
    ambient_sound: Optional[str] = Field(default=None, description="New ambient sound setting")
    enable_backchannel: Optional[bool] = Field(default=None, description="Toggle backchannels")
    interruption_sensitivity: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    responsiveness: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    end_call_after_silence_ms: Optional[int] = Field(default=None, ge=1000)
    max_call_duration_ms: Optional[int] = Field(default=None)
    post_call_analysis_data: Optional[List[Dict]] = Field(default=None)


class DeleteAgentInput(BaseModel):
    agent_id: str = Field(..., description="The agent ID to delete", min_length=1)


class ListCallsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    limit: Optional[int] = Field(default=20, ge=1, le=100, description="Max calls to return (default 20)")
    agent_id: Optional[str] = Field(default=None, description="Filter calls by agent ID")
    filter_criteria: Optional[Dict] = Field(default=None, description="Additional filter criteria dict")


class GetCallInput(BaseModel):
    call_id: str = Field(..., description="The Retell call ID (e.g., 'call_abc123')", min_length=1)


class CreatePhoneCallInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    from_number: str = Field(
        ...,
        description="Your Retell phone number in E.164 format (e.g., '+15012345678')",
        min_length=10
    )
    to_number: str = Field(
        ...,
        description="Destination number in E.164 format (e.g., '+19185551234'). US numbers only for Retell-purchased numbers.",
        min_length=10
    )
    agent_id: Optional[str] = Field(
        default=None,
        description="Override the agent assigned to this number for this call only"
    )
    dynamic_variables: Optional[Dict[str, str]] = Field(
        default=None,
        description="Key-value pairs injected into the agent prompt (e.g., {'patient_name': 'John Smith', 'appointment_date': 'Tuesday April 8'})"
    )
    metadata: Optional[Dict] = Field(
        default=None,
        description="Arbitrary metadata attached to the call (not visible to agent)"
    )


class ListPhoneNumbersInput(BaseModel):
    limit: Optional[int] = Field(default=50, ge=1, le=200, description="Max phone numbers to return")


class GetPhoneNumberInput(BaseModel):
    phone_number: str = Field(..., description="Phone number in E.164 format (e.g., '+15012345678')")


class UpdatePhoneNumberInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    phone_number: str = Field(..., description="Phone number in E.164 format to update")
    agent_id: Optional[str] = Field(
        default=None,
        description="Agent ID to assign to this number. Pass null to unassign."
    )
    outbound_caller_id: Optional[str] = Field(
        default=None,
        description="Caller ID shown on outbound calls from this number"
    )
    nickname: Optional[str] = Field(
        default=None,
        description="Friendly name for this number (e.g., 'Roland OK Front Desk')"
    )


class ImportPhoneNumberInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    phone_number: str = Field(..., description="Phone number to import in E.164 format")
    termination_uri: str = Field(..., description="SIP termination URI for the number")
    agent_id: Optional[str] = Field(default=None, description="Agent to assign immediately after import")
    nickname: Optional[str] = Field(default=None, description="Friendly label for this number")


class DeletePhoneNumberInput(BaseModel):
    phone_number: str = Field(..., description="Phone number in E.164 format to delete")


class ListLLMsInput(BaseModel):
    limit: Optional[int] = Field(default=50, ge=1, le=200, description="Max LLMs to return")


class GetLLMInput(BaseModel):
    llm_id: str = Field(..., description="The Retell LLM ID (e.g., 'llm_abc123')", min_length=1)


class CreateLLMInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    model: Optional[str] = Field(
        default="gpt-4o",
        description="LLM model to use (e.g., 'gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet')"
    )
    system_prompt: Optional[str] = Field(
        default=None,
        description="The full system prompt defining agent behavior, personality, and workflows"
    )
    begin_message: Optional[str] = Field(
        default=None,
        description="First message the agent says when a call connects (e.g., 'Thank you for calling Roland Dental, this is Aria...')"
    )
    general_tools: Optional[List[Dict]] = Field(
        default=None,
        description="Tools the agent can call during conversation (e.g., check_availability, book_appointment)"
    )
    states: Optional[List[Dict]] = Field(
        default=None,
        description="State machine nodes for structured multi-step conversations (advanced)"
    )
    starting_state: Optional[str] = Field(
        default=None,
        description="Name of the initial state node if using state machine"
    )
    inactivity_messages: Optional[List[Dict]] = Field(
        default=None,
        description="Messages sent after periods of user silence"
    )


class UpdateLLMInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    llm_id: str = Field(..., description="The LLM ID to update", min_length=1)
    model: Optional[str] = Field(default=None, description="New model (e.g., 'gpt-4o-mini')")
    system_prompt: Optional[str] = Field(default=None, description="New system prompt")
    begin_message: Optional[str] = Field(default=None, description="New opening message")
    general_tools: Optional[List[Dict]] = Field(default=None, description="New or updated tools list")
    states: Optional[List[Dict]] = Field(default=None, description="New state machine")
    starting_state: Optional[str] = Field(default=None, description="New starting state name")
    inactivity_messages: Optional[List[Dict]] = Field(default=None)


class DeleteLLMInput(BaseModel):
    llm_id: str = Field(..., description="The LLM ID to delete", min_length=1)


# ─── Agent Tools ───────────────────────────────────────────────────────────────

@mcp.tool(
    name="retell_list_agents",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_list_agents(params: ListAgentsInput) -> str:
    """List all Retell AI voice agents in your account.

    Returns agent IDs, names, voice settings, webhook config, and associated LLM IDs.
    Use this to discover existing agents, find agent IDs, or audit your agent roster.

    Returns:
        str: JSON array of agent objects with full configuration details.
    """
    try:
        data = await _api_request("GET", "/list-agents")
        agents = data if isinstance(data, list) else data.get("agents", [])
        agents = agents[: params.limit]
        return json.dumps({"count": len(agents), "agents": agents}, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_get_agent",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_get_agent(params: GetAgentInput) -> str:
    """Get full configuration details for a specific Retell AI agent by ID.

    Returns all settings: voice, language, LLM, webhook, interruption, post-call analysis, etc.

    Args:
        params.agent_id: The agent ID (e.g., 'agent_abc123')

    Returns:
        str: JSON object with complete agent configuration.
    """
    try:
        data = await _api_request("GET", f"/get-agent/{params.agent_id}")
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_create_agent",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
)
async def retell_create_agent(params: CreateAgentInput) -> str:
    """Create a new Retell AI voice agent.

    Provide either response_engine_llm_id (to use a Retell LLM) or llm_websocket_url
    (for a custom LLM server). For CareIN, use response_engine_llm_id with a Retell LLM
    that holds your dental scheduling prompt.

    Args:
        params.agent_name: Descriptive name (e.g., 'CareIN - Roland OK')
        params.response_engine_llm_id: Retell LLM ID for the agent's brain
        params.voice_id: Voice to use (default: '11labs-Adrian')
        params.webhook_url: Where to send call events for Open Dental commlog writing
        params.post_call_analysis_data: Fields to extract after call ends

    Returns:
        str: JSON with new agent_id and full configuration.
    """
    try:
        body: Dict[str, Any] = {"agent_name": params.agent_name}

        if params.response_engine_llm_id:
            body["response_engine"] = {
                "type": "retell-llm",
                "llm_id": params.response_engine_llm_id
            }
        elif params.llm_websocket_url:
            body["llm_websocket_url"] = params.llm_websocket_url

        body["voice_id"] = params.voice_id
        if params.voice_model:
            body["voice_model"] = params.voice_model
        if params.language:
            body["language"] = params.language
        if params.webhook_url:
            body["webhook_url"] = params.webhook_url
        if params.webhook_events:
            body["webhook_events"] = params.webhook_events
        if params.ambient_sound:
            body["ambient_sound"] = params.ambient_sound
        if params.enable_backchannel is not None:
            body["enable_backchannel"] = params.enable_backchannel
        if params.interruption_sensitivity is not None:
            body["interruption_sensitivity"] = params.interruption_sensitivity
        if params.responsiveness is not None:
            body["responsiveness"] = params.responsiveness
        if params.end_call_after_silence_ms is not None:
            body["end_call_after_silence_ms"] = params.end_call_after_silence_ms
        if params.max_call_duration_ms is not None:
            body["max_call_duration_ms"] = params.max_call_duration_ms
        if params.post_call_analysis_data:
            body["post_call_analysis_data"] = params.post_call_analysis_data

        data = await _api_request("POST", "/create-agent", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_update_agent",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_update_agent(params: UpdateAgentInput) -> str:
    """Update an existing Retell AI agent's configuration (latest draft version).

    Only include fields you want to change — all others are left untouched.
    Common updates: swap the LLM prompt, change voice, update webhook, toggle backchannels.

    Args:
        params.agent_id: Agent to update
        params.response_engine_llm_id: Swap to a different Retell LLM
        params.voice_id: Change voice
        params.webhook_url: Update webhook endpoint

    Returns:
        str: JSON with updated agent configuration.
    """
    try:
        body: Dict[str, Any] = {}

        if params.agent_name:
            body["agent_name"] = params.agent_name
        if params.response_engine_llm_id:
            body["response_engine"] = {
                "type": "retell-llm",
                "llm_id": params.response_engine_llm_id
            }
        elif params.llm_websocket_url:
            body["llm_websocket_url"] = params.llm_websocket_url
        if params.voice_id:
            body["voice_id"] = params.voice_id
        if params.language:
            body["language"] = params.language
        if params.webhook_url is not None:
            body["webhook_url"] = params.webhook_url
        if params.webhook_events is not None:
            body["webhook_events"] = params.webhook_events
        if params.ambient_sound is not None:
            body["ambient_sound"] = params.ambient_sound
        if params.enable_backchannel is not None:
            body["enable_backchannel"] = params.enable_backchannel
        if params.interruption_sensitivity is not None:
            body["interruption_sensitivity"] = params.interruption_sensitivity
        if params.responsiveness is not None:
            body["responsiveness"] = params.responsiveness
        if params.end_call_after_silence_ms is not None:
            body["end_call_after_silence_ms"] = params.end_call_after_silence_ms
        if params.max_call_duration_ms is not None:
            body["max_call_duration_ms"] = params.max_call_duration_ms
        if params.post_call_analysis_data is not None:
            body["post_call_analysis_data"] = params.post_call_analysis_data

        data = await _api_request("PATCH", f"/update-agent/{params.agent_id}", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_delete_agent",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": True}
)
async def retell_delete_agent(params: DeleteAgentInput) -> str:
    """Permanently delete a Retell AI agent. This is irreversible.

    Args:
        params.agent_id: The agent ID to delete

    Returns:
        str: Confirmation message.
    """
    try:
        await _api_request("DELETE", f"/delete-agent/{params.agent_id}")
        return json.dumps({"success": True, "deleted_agent_id": params.agent_id})
    except Exception as e:
        return _handle_error(e)


# ─── Call Tools ────────────────────────────────────────────────────────────────

@mcp.tool(
    name="retell_list_calls",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_list_calls(params: ListCallsInput) -> str:
    """List recent calls from your Retell AI account, with optional agent filter.

    Returns call IDs, status, duration, agent, phone numbers, transcript preview,
    and post-call analysis results. Use this to review CareIN call logs and outcomes.

    Args:
        params.limit: Number of calls to return (default 20)
        params.agent_id: Filter by specific agent (e.g., only Roland OK calls)

    Returns:
        str: JSON array of call objects with metadata.
    """
    try:
        body: Dict[str, Any] = {"limit": params.limit}
        if params.agent_id:
            body["filter_criteria"] = [{"field": "agent_id", "operator": "=", "value": params.agent_id}]
        elif params.filter_criteria:
            body["filter_criteria"] = params.filter_criteria

        data = await _api_request("POST", "/list-calls", body=body)
        calls = data if isinstance(data, list) else data.get("calls", [])
        return json.dumps({"count": len(calls), "calls": calls}, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_get_call",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_get_call(params: GetCallInput) -> str:
    """Get full details for a single call including transcript, recording URL, and post-call analysis.

    Returns the complete transcript (speaker-labeled), call duration, outcome, agent used,
    from/to numbers, and any extracted post-call analysis fields (call reason, appointment booked, etc.).
    Use this to build Open Dental commlog entries.

    Args:
        params.call_id: The Retell call ID (e.g., 'call_abc123')

    Returns:
        str: JSON with complete call details including full transcript.
    """
    try:
        data = await _api_request("GET", f"/get-call/{params.call_id}")
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_create_phone_call",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
)
async def retell_create_phone_call(params: CreatePhoneCallInput) -> str:
    """Initiate an outbound phone call using a Retell AI agent.

    Triggers an immediate outbound call. Use dynamic_variables to inject patient-specific
    context into the agent prompt at call time (name, appointment date, balance due, etc.).

    Args:
        params.from_number: Your Retell number in E.164 (e.g., '+15012345678')
        params.to_number: Patient/destination number in E.164 (e.g., '+19185551234')
        params.agent_id: Override the default agent for this number (optional)
        params.dynamic_variables: Patient context injected into prompt
          e.g., {'patient_name': 'Sarah Jones', 'appt_date': 'Tuesday April 8 at 2pm'}

    Returns:
        str: JSON with call_id and initial status.
    """
    try:
        body: Dict[str, Any] = {
            "from_number": params.from_number,
            "to_number": params.to_number,
        }
        if params.agent_id:
            body["override_agent_id"] = params.agent_id
        if params.dynamic_variables:
            body["retell_llm_dynamic_variables"] = params.dynamic_variables
        if params.metadata:
            body["metadata"] = params.metadata

        data = await _api_request("POST", "/create-phone-call", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


# ─── Phone Number Tools ────────────────────────────────────────────────────────

@mcp.tool(
    name="retell_list_phone_numbers",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_list_phone_numbers(params: ListPhoneNumbersInput) -> str:
    """List all phone numbers in your Retell account.

    Shows which agent is assigned to each number, the number's nickname, and
    SIP/carrier configuration. Use this to see how your dental practice lines are mapped.

    Returns:
        str: JSON array of phone number objects.
    """
    try:
        data = await _api_request("GET", "/list-phone-numbers")
        numbers = data if isinstance(data, list) else data.get("phone_numbers", [])
        numbers = numbers[: params.limit]
        return json.dumps({"count": len(numbers), "phone_numbers": numbers}, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_get_phone_number",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_get_phone_number(params: GetPhoneNumberInput) -> str:
    """Get details for a specific phone number including its assigned agent.

    Args:
        params.phone_number: Phone number in E.164 format (e.g., '+15012345678')

    Returns:
        str: JSON with phone number config and assigned agent_id.
    """
    try:
        data = await _api_request("GET", f"/get-phone-number/{params.phone_number}")
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_update_phone_number",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_update_phone_number(params: UpdatePhoneNumberInput) -> str:
    """Update a phone number — typically to assign or reassign a CareIN agent.

    This is how you bind a dental practice phone line to a CareIN agent.
    You can also set a nickname for easy identification.

    Args:
        params.phone_number: The number to update (E.164 format)
        params.agent_id: The CareIN agent to assign to this line
        params.nickname: Friendly label (e.g., 'Roland OK Main Line')

    Returns:
        str: JSON with updated phone number configuration.
    """
    try:
        body: Dict[str, Any] = {}
        if params.agent_id is not None:
            body["agent_id"] = params.agent_id
        if params.outbound_caller_id:
            body["outbound_caller_id"] = params.outbound_caller_id
        if params.nickname:
            body["nickname"] = params.nickname

        data = await _api_request("PATCH", f"/update-phone-number/{params.phone_number}", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_import_phone_number",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
)
async def retell_import_phone_number(params: ImportPhoneNumberInput) -> str:
    """Import an existing phone number into Retell via SIP termination URI.

    Use this to bring your existing dental practice phone numbers into Retell
    without porting them away from your current carrier.

    Args:
        params.phone_number: Number to import in E.164 format
        params.termination_uri: Your carrier's SIP termination URI
        params.agent_id: Assign a CareIN agent immediately after import
        params.nickname: Label (e.g., 'Fort Smith AR Main Line')

    Returns:
        str: JSON with imported phone number details.
    """
    try:
        body: Dict[str, Any] = {
            "phone_number": params.phone_number,
            "termination_uri": params.termination_uri,
        }
        if params.agent_id:
            body["agent_id"] = params.agent_id
        if params.nickname:
            body["nickname"] = params.nickname

        data = await _api_request("POST", "/import-phone-number", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_delete_phone_number",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": True}
)
async def retell_delete_phone_number(params: DeletePhoneNumberInput) -> str:
    """Remove a phone number from Retell. Irreversible.

    Args:
        params.phone_number: Phone number in E.164 format to delete

    Returns:
        str: Confirmation message.
    """
    try:
        await _api_request("DELETE", f"/delete-phone-number/{params.phone_number}")
        return json.dumps({"success": True, "deleted": params.phone_number})
    except Exception as e:
        return _handle_error(e)


# ─── LLM / Response Engine Tools ──────────────────────────────────────────────

@mcp.tool(
    name="retell_list_llms",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_list_llms(params: ListLLMsInput) -> str:
    """List all Retell LLM Response Engines in your account.

    Shows LLM IDs, models, begin messages, and partial system prompts.
    Use this to audit CareIN agent brains or find the LLM ID to attach to a new agent.

    Returns:
        str: JSON array of LLM objects.
    """
    try:
        data = await _api_request("GET", "/list-retell-llms")
        llms = data if isinstance(data, list) else data.get("llms", [])
        llms = llms[: params.limit]
        return json.dumps({"count": len(llms), "llms": llms}, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_get_llm",
    annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_get_llm(params: GetLLMInput) -> str:
    """Get full details for a Retell LLM Response Engine including full system prompt.

    Returns the complete system prompt, begin message, tools, and state machine config.
    Use this to read and review your CareIN agent's prompt before updates.

    Args:
        params.llm_id: LLM ID (e.g., 'llm_abc123')

    Returns:
        str: JSON with complete LLM configuration including full system_prompt.
    """
    try:
        data = await _api_request("GET", f"/get-retell-llm/{params.llm_id}")
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_create_llm",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
)
async def retell_create_llm(params: CreateLLMInput) -> str:
    """Create a new Retell LLM Response Engine — the 'brain' attached to a voice agent.

    This is where the CareIN scheduling logic, persona, and call routing lives.
    The system_prompt should contain your dental office persona, scheduling rules,
    FAQ answers, and instructions for when to transfer to a human.

    The begin_message is the first thing the agent says when a call connects.

    Args:
        params.model: LLM model (default: 'gpt-4o')
        params.system_prompt: Full system prompt with persona + scheduling logic
        params.begin_message: Opening line (e.g., 'Thank you for calling Roland Dental...')
        params.general_tools: API tools the agent can call (e.g., check_schedule, book_appointment)
        params.states: State machine for multi-step flows (advanced)

    Returns:
        str: JSON with new llm_id and configuration.
    """
    try:
        body: Dict[str, Any] = {}
        if params.model:
            body["model"] = params.model
        if params.system_prompt:
            body["general_prompt"] = params.system_prompt
        if params.begin_message:
            body["begin_message"] = params.begin_message
        if params.general_tools:
            body["general_tools"] = params.general_tools
        if params.states:
            body["states"] = params.states
        if params.starting_state:
            body["starting_state"] = params.starting_state
        if params.inactivity_messages:
            body["inactivity_messages"] = params.inactivity_messages

        data = await _api_request("POST", "/create-retell-llm", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_update_llm",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}
)
async def retell_update_llm(params: UpdateLLMInput) -> str:
    """Update an existing Retell LLM Response Engine.

    Use this to iterate on your CareIN system prompt, update scheduling rules,
    add new tools, or modify the opening message. Only include fields you want to change.

    Args:
        params.llm_id: LLM to update
        params.system_prompt: Replace the full system prompt
        params.begin_message: Update opening message
        params.general_tools: Replace full tools list
        params.model: Swap to a different LLM model

    Returns:
        str: JSON with updated LLM configuration.
    """
    try:
        body: Dict[str, Any] = {}
        if params.model:
            body["model"] = params.model
        if params.system_prompt is not None:
            body["general_prompt"] = params.system_prompt
        if params.begin_message is not None:
            body["begin_message"] = params.begin_message
        if params.general_tools is not None:
            body["general_tools"] = params.general_tools
        if params.states is not None:
            body["states"] = params.states
        if params.starting_state is not None:
            body["starting_state"] = params.starting_state
        if params.inactivity_messages is not None:
            body["inactivity_messages"] = params.inactivity_messages

        data = await _api_request("PATCH", f"/update-retell-llm/{params.llm_id}", body=body)
        return json.dumps(data, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="retell_delete_llm",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": True}
)
async def retell_delete_llm(params: DeleteLLMInput) -> str:
    """Permanently delete a Retell LLM Response Engine. Irreversible.

    Note: Unassign this LLM from any agents before deleting.

    Args:
        params.llm_id: LLM ID to delete

    Returns:
        str: Confirmation message.
    """
    try:
        await _api_request("DELETE", f"/delete-retell-llm/{params.llm_id}")
        return json.dumps({"success": True, "deleted_llm_id": params.llm_id})
    except Exception as e:
        return _handle_error(e)


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
