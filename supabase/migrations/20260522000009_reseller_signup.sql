-- Update handle_new_user to support reseller (and affiliate) intended_role at signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  intended text;
  resolved_role public.user_role;
BEGIN
  intended := NEW.raw_user_meta_data->>'intended_role';
  IF intended = 'vendor' THEN
    resolved_role := 'vendor';
  ELSIF intended = 'reseller' THEN
    resolved_role := 'reseller';
  ELSIF intended = 'affiliate' THEN
    resolved_role := 'affiliate';
  ELSE
    resolved_role := 'buyer';
  END IF;

  INSERT INTO public.profiles (id, role)
  VALUES (NEW.id, resolved_role);

  RETURN NEW;
END;
$$;
