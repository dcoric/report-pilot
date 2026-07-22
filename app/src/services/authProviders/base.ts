import type { AuthProviderType } from "../../types/domain";
import type { AuthProviderService } from "./index";
import type { ProviderRow } from "../authProviderService";
import { completeLogin, startLogin, testConnection } from "../oidcService";

export abstract class OidcBackedAuthProviderService implements AuthProviderService {
  abstract type: AuthProviderType;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: any }> {
    return startLogin(provider);
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: any): Promise<any> {
    return completeLogin(provider, currentUrl, flowState);
  }

  async testConnection(provider: ProviderRow): Promise<any> {
    return testConnection(provider);
  }

  buildPrincipal(claims: any): any {
    return {
      email: claims.email,
      sub: claims.sub,
      display_name: claims.name,
      claims
    };
  }
}
