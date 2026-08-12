from typing import Any, Required, TypedDict, Union


class WebxPermissionsConfiguration(TypedDict, total=False):
    """
    WebX permissions configuration.

    $comment: Normative structural schema generated from the canonical example. The typed loader also enforces documented cross-field semantic rules.
    """

    schema_version: Required[int]
    """ Required property """

    default_effect: Required[str]
    """ Required property """

    roles: Required[Union[dict[str, dict[str, Any]], "_WebxPermissionsConfigurationRolesTyped"]]
    """

    WARNING: Normally the types should be a mix of each other instead of Union.
    See: https://github.com/camptocamp/jsonschema-gentypes/issues/7

    Required property
    """

    actors: Required[Union[dict[str, dict[str, Any]], "_WebxPermissionsConfigurationActorsTyped"]]
    """

    WARNING: Normally the types should be a mix of each other instead of Union.
    See: https://github.com/camptocamp/jsonschema-gentypes/issues/7

    Required property
    """

    approval_rules: Required[list["_WebxPermissionsConfigurationApprovalRulesItem"]]
    """ Required property """

    hard_denials: Required[list[str]]
    """ Required property """

    network_profiles: Required[Union[dict[str, dict[str, Any]], "_WebxPermissionsConfigurationNetworkProfilesTyped"]]
    """

    WARNING: Normally the types should be a mix of each other instead of Union.
    See: https://github.com/camptocamp/jsonschema-gentypes/issues/7

    Required property
    """



class _WebxPermissionsConfigurationActorsLlmWiki(TypedDict, total=False):
    role: Required[str]
    """ Required property """

    max_visibility: Required[str]
    """ Required property """

    allowed_scopes: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationActorsLocalUser(TypedDict, total=False):
    role: Required[str]
    """ Required property """

    max_visibility: Required[str]
    """ Required property """



class _WebxPermissionsConfigurationActorsPiAgent(TypedDict, total=False):
    role: Required[str]
    """ Required property """

    max_visibility: Required[str]
    """ Required property """

    denied_scopes: Required[list[str]]
    """ Required property """



_WebxPermissionsConfigurationActorsTyped = TypedDict('_WebxPermissionsConfigurationActorsTyped', {
    # | Required property
    'local-user': Required["_WebxPermissionsConfigurationActorsLocalUser"],
    # | Required property
    'pi-agent': Required["_WebxPermissionsConfigurationActorsPiAgent"],
    # | Required property
    'llm-wiki': Required["_WebxPermissionsConfigurationActorsLlmWiki"],
}, total=False)


_WebxPermissionsConfigurationApprovalRulesItem = Union["_WebxPermissionsConfigurationApprovalRulesItemAnyof0", "_WebxPermissionsConfigurationApprovalRulesItemAnyof1", "_WebxPermissionsConfigurationApprovalRulesItemAnyof2", "_WebxPermissionsConfigurationApprovalRulesItemAnyof3", "_WebxPermissionsConfigurationApprovalRulesItemAnyof4", "_WebxPermissionsConfigurationApprovalRulesItemAnyof5"]
""" Aggregation type: anyOf """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof0(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    when_scope: Required[str]
    """ Required property """

    approval: Required[str]
    """ Required property """

    maximum_duration_seconds: Required[int]
    """ Required property """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof1(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    when_scope: Required[str]
    """ Required property """

    approval: Required[str]
    """ Required property """

    display_fields: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof2(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    when_scope: Required[str]
    """ Required property """

    approval: Required[str]
    """ Required property """

    require_reason: Required[bool]
    """ Required property """

    maximum_bytes: Required[int]
    """ Required property """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof3(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    when_scope: Required[str]
    """ Required property """

    approval: Required[str]
    """ Required property """

    require_reason: Required[bool]
    """ Required property """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof4(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    when_scope: Required[str]
    """ Required property """

    approval: Required[str]
    """ Required property """

    thresholds: Required["_WebxPermissionsConfigurationApprovalRulesItemAnyof4Thresholds"]
    """ Required property """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof4Thresholds(TypedDict, total=False):
    pages: Required[int]
    """ Required property """

    bytes: Required[int]
    """ Required property """

    duration_seconds: Required[int]
    """ Required property """



class _WebxPermissionsConfigurationApprovalRulesItemAnyof5(TypedDict, total=False):
    id: Required[str]
    """ Required property """

    when_scope: Required[str]
    """ Required property """

    approval: Required[str]
    """ Required property """



class _WebxPermissionsConfigurationNetworkProfilesApprovedPrivate(TypedDict, total=False):
    allow_public_http_https: Required[bool]
    """ Required property """

    allow_private_addresses: Required[bool]
    """ Required property """

    requires_role: Required[str]
    """ Required property """

    requires_per_target_allowlist: Required[bool]
    """ Required property """



class _WebxPermissionsConfigurationNetworkProfilesOffline(TypedDict, total=False):
    allow_public_http_https: Required[bool]
    """ Required property """

    allow_private_addresses: Required[bool]
    """ Required property """

    allow_loopback: Required[bool]
    """ Required property """

    loopback_services_allowlist: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationNetworkProfilesPublicWeb(TypedDict, total=False):
    allow_public_http_https: Required[bool]
    """ Required property """

    allow_private_addresses: Required[bool]
    """ Required property """

    allow_loopback: Required[bool]
    """ Required property """



class _WebxPermissionsConfigurationNetworkProfilesTyped(TypedDict, total=False):
    public_web: Required["_WebxPermissionsConfigurationNetworkProfilesPublicWeb"]
    """ Required property """

    offline: Required["_WebxPermissionsConfigurationNetworkProfilesOffline"]
    """ Required property """

    approved_private: Required["_WebxPermissionsConfigurationNetworkProfilesApprovedPrivate"]
    """ Required property """



class _WebxPermissionsConfigurationRolesAdministrator(TypedDict, total=False):
    inherits: Required[list[str]]
    """ Required property """

    scopes: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationRolesElevatedOperator(TypedDict, total=False):
    inherits: Required[list[str]]
    """ Required property """

    scopes: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationRolesOperator(TypedDict, total=False):
    inherits: Required[list[str]]
    """ Required property """

    scopes: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationRolesReader(TypedDict, total=False):
    scopes: Required[list[str]]
    """ Required property """



class _WebxPermissionsConfigurationRolesTyped(TypedDict, total=False):
    reader: Required["_WebxPermissionsConfigurationRolesReader"]
    """ Required property """

    operator: Required["_WebxPermissionsConfigurationRolesOperator"]
    """ Required property """

    elevated_operator: Required["_WebxPermissionsConfigurationRolesElevatedOperator"]
    """ Required property """

    administrator: Required["_WebxPermissionsConfigurationRolesAdministrator"]
    """ Required property """
