# Things to know

This is information, not guidance. How you use the system is up to you.

**LLMs hallucinate.** Every search hit, summary, synthesis, and tag in this system passes through an LLM at some point. Claims that sound confident often aren't. PaperQA2's passage-level citations help — verify the quoted text says what the synthesis says it says. The scientist using the system is responsible for every claim that ends up in a grant, paper, or talk; the system is a faster way to find and organize evidence, not a way to outsource interpretation.

**NIH and most journals do not want LLM-generated content** in grant applications or manuscripts. Policies vary and evolve, and what counts as "AI use" disclosure differs by venue. If you use synthesis outputs from this system while preparing an NIH submission or a journal manuscript, check the current policy for your target before submission. The system itself does not enforce any of this.

**This system is built for public information.** It sends paper text to OpenRouter (embeddings), Anthropic (LLM tagging, synthesis, scoring), and NCBI/PubMed (metadata) — all third-party services. **Do not put unpublished manuscripts under embargo, peer-review papers you've been assigned, IRB-protected human-subjects data, HIPAA-protected clinical data, or any other sensitive content into the vault as shipped.** If you need that, swap in a local LLM workflow (Ollama, [PaperQA2 with a local model](https://github.com/Future-House/paper-qa)) before adding the data.
