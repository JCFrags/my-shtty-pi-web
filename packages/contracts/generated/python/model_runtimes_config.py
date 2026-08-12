from typing import Required, TypedDict, Union


class WebxLocalModelRuntimeConfiguration(TypedDict, total=False):
    """
    WebX local model runtime configuration.

    $comment: Normative structural schema generated from the canonical example. The typed loader also enforces documented cross-field semantic rules.
    allOf:
      - not:
          properties:
            runtimes:
              contains:
                properties:
                  kind:
                    const: ollama
                required:
                - kind
                type: object
    """

    schema_version: Required[int]
    """ Required property """

    runtimes: Required[list["_WebxLocalModelRuntimeConfigurationRuntimesItem"]]
    """ Required property """

    profiles: Required["_WebxLocalModelRuntimeConfigurationProfiles"]
    """ Required property """

    validation: Required["_WebxLocalModelRuntimeConfigurationValidation"]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationProfiles(TypedDict, total=False):
    generation_default: Required["_WebxLocalModelRuntimeConfigurationProfilesGenerationDefault"]
    """ Required property """

    embeddings_default: Required["_WebxLocalModelRuntimeConfigurationProfilesEmbeddingsDefault"]
    """ Required property """

    rerank_default: Required["_WebxLocalModelRuntimeConfigurationProfilesRerankDefault"]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationProfilesEmbeddingsDefault(TypedDict, total=False):
    workload: Required[str]
    """ Required property """

    runtime_preference: Required[list[str]]
    """ Required property """

    batch_size: Required[int]
    """ Required property """

    timeout_seconds: Required[int]
    """ Required property """

    normalize: Required[bool]
    """ Required property """

    external_tools: Required[bool]
    """ Required property """

    filesystem_access: Required[bool]
    """ Required property """

    network_access: Required[bool]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationProfilesGenerationDefault(TypedDict, total=False):
    workload: Required[str]
    """ Required property """

    runtime_preference: Required[list[str]]
    """ Required property """

    temperature: Required[int]
    """ Required property """

    top_p: Required[int]
    """ Required property """

    timeout_seconds: Required[int]
    """ Required property """

    max_retries: Required[int]
    """ Required property """

    require_json_schema: Required[bool]
    """ Required property """

    external_tools: Required[bool]
    """ Required property """

    filesystem_access: Required[bool]
    """ Required property """

    network_access: Required[bool]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationProfilesRerankDefault(TypedDict, total=False):
    workload: Required[str]
    """ Required property """

    runtime_preference: Required[list[str]]
    """ Required property """

    batch_size: Required[int]
    """ Required property """

    timeout_seconds: Required[int]
    """ Required property """

    external_tools: Required[bool]
    """ Required property """

    filesystem_access: Required[bool]
    """ Required property """

    network_access: Required[bool]
    """ Required property """



_WebxLocalModelRuntimeConfigurationRuntimesItem = Union["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0", "_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1"]
""" Aggregation type: anyOf """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    kind: Required[str]
    """ Required property """

    enabled: Required[bool]
    """ Required property """

    base_url: Required[str]
    """ Required property """

    api_key_secret_ref: Required[str]
    """ Required property """

    health_path: Required[str]
    """ Required property """

    concurrency: Required[int]
    """ Required property """

    models: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0Models"]
    """ Required property """

    launch_profile: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0LaunchProfile"]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0LaunchProfile(TypedDict, total=False):
    managed: Required[bool]
    """ Required property """

    command: Required[str]
    """ Required property """

    arguments: Required[list[str]]
    """ Required property """

    model_paths_allowed: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0Models(TypedDict, total=False):
    generation: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0ModelsGeneration"]
    """ Required property """

    embeddings: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0ModelsEmbeddings"]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0ModelsEmbeddings(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    dimensions: Required[str]
    """ Required property """

    capabilities: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof0ModelsGeneration(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    context_window: Required[int]
    """ Required property """

    max_output_tokens: Required[int]
    """ Required property """

    capabilities: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    kind: Required[str]
    """ Required property """

    enabled: Required[bool]
    """ Required property """

    base_url: Required[str]
    """ Required property """

    api_key_secret_ref: Required[str]
    """ Required property """

    health_path: Required[str]
    """ Required property """

    concurrency: Required[int]
    """ Required property """

    models: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1Models"]
    """ Required property """

    launch_profile: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1LaunchProfile"]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1LaunchProfile(TypedDict, total=False):
    managed: Required[bool]
    """ Required property """

    command: Required[str]
    """ Required property """

    arguments: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1Models(TypedDict, total=False):
    generation: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1ModelsGeneration"]
    """ Required property """

    embeddings: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1ModelsEmbeddings"]
    """ Required property """

    rerank: Required["_WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1ModelsRerank"]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1ModelsEmbeddings(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    dimensions: Required[str]
    """ Required property """

    capabilities: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1ModelsGeneration(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    context_window: Required[int]
    """ Required property """

    max_output_tokens: Required[int]
    """ Required property """

    capabilities: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationRuntimesItemAnyof1ModelsRerank(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    capabilities: Required[list[str]]
    """ Required property """



class _WebxLocalModelRuntimeConfigurationValidation(TypedDict, total=False):
    reject_runtime_kinds: Required[list[str]]
    """ Required property """

    reject_non_loopback_or_internal_urls: Required[bool]
    """ Required property """

    reject_unlisted_models: Required[bool]
    """ Required property """

    require_model_identity_in_outputs: Required[bool]
    """ Required property """

    require_source_hash_in_cache_key: Required[bool]
    """ Required property """
