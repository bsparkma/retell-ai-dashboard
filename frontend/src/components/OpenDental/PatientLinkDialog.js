/**
 * Patient Link Dialog
 * 
 * A dialog component for manually linking calls to Open Dental patients.
 * Shows suggested matches and allows searching for other patients.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  ListItemSecondaryAction,
  Avatar,
  Chip,
  CircularProgress,
  Alert,
  Divider,
  InputAdornment,
  IconButton,
  Tooltip,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import {
  Person as PersonIcon,
  Search as SearchIcon,
  Phone as PhoneIcon,
  Email as EmailIcon,
  Link as LinkIcon,
  LinkOff as UnlinkIcon,
  CheckCircle as CheckIcon,
  LocalHospital as DentalIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { openDentalSyncApi } from '../../services/api';

const PatientLinkDialog = ({ 
  open, 
  onClose, 
  call, 
  onLinkSuccess,
  patientSuggestions = []
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [syncNow, setSyncNow] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('');
      setSearchResults([]);
      setError(null);
      setSuccess(null);
      
      // Pre-populate search with caller name or number
      if (call?.caller_name && call.caller_name !== 'Unknown') {
        setSearchQuery(call.caller_name);
      } else if (call?.caller_number) {
        setSearchQuery(call.caller_number);
      }
    }
  }, [open, call]);

  // Search patients
  const handleSearch = useCallback(async () => {
    if (!searchQuery || searchQuery.length < 2) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await openDentalSyncApi.searchPatients(searchQuery);
      setSearchResults(result.patients || []);
    } catch (err) {
      console.error('Patient search error:', err);
      setError('Failed to search patients. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  // Link call to patient
  const handleLink = async (patient) => {
    setLinking(true);
    setError(null);
    setSuccess(null);
    
    try {
      const result = await openDentalSyncApi.linkCallToPatient(call.id, patient.id, {
        syncNow,
        includeTranscript
      });
      
      if (result.success) {
        setSuccess(`Successfully linked to ${patient.fullName || `${patient.firstName} ${patient.lastName}`}`);
        
        // Wait a moment then close
        setTimeout(() => {
          if (onLinkSuccess) {
            onLinkSuccess(result);
          }
          onClose();
        }, 1500);
      } else {
        setError(result.error || 'Failed to link patient');
      }
    } catch (err) {
      console.error('Link error:', err);
      setError(err.response?.data?.error || 'Failed to link patient');
    } finally {
      setLinking(false);
    }
  };

  // Handle Enter key in search
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  // Render patient item
  const renderPatientItem = (patient, matchType = null) => {
    const fullName = patient.fullName || `${patient.firstName || ''} ${patient.lastName || ''}`.trim();
    
    return (
      <ListItem 
        key={patient.id}
        sx={{ 
          borderRadius: 1,
          mb: 1,
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider',
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        <ListItemAvatar>
          <Avatar sx={{ bgcolor: 'primary.main' }}>
            <PersonIcon />
          </Avatar>
        </ListItemAvatar>
        
        <ListItemText
          primary={
            <Box display="flex" alignItems="center" gap={1}>
              <Typography fontWeight="medium">{fullName || 'Unknown'}</Typography>
              {matchType && (
                <Chip 
                  size="small" 
                  label={matchType === 'phone' ? 'Phone Match' : 'Name Match'}
                  color={matchType === 'phone' ? 'success' : 'info'}
                  variant="outlined"
                />
              )}
            </Box>
          }
          secondary={
            <Box component="span" display="flex" flexDirection="column" gap={0.5} mt={0.5}>
              {patient.phone && (
                <Box component="span" display="flex" alignItems="center" gap={0.5}>
                  <PhoneIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                  <Typography variant="caption" color="text.secondary">
                    {patient.phone}
                  </Typography>
                </Box>
              )}
              {patient.email && (
                <Box component="span" display="flex" alignItems="center" gap={0.5}>
                  <EmailIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                  <Typography variant="caption" color="text.secondary">
                    {patient.email}
                  </Typography>
                </Box>
              )}
              {patient.dateOfBirth && (
                <Typography variant="caption" color="text.secondary">
                  DOB: {patient.dateOfBirth}
                </Typography>
              )}
            </Box>
          }
        />
        
        <ListItemSecondaryAction>
          <Button
            variant="contained"
            size="small"
            startIcon={linking ? <CircularProgress size={16} /> : <LinkIcon />}
            onClick={() => handleLink(patient)}
            disabled={linking}
          >
            Link
          </Button>
        </ListItemSecondaryAction>
      </ListItem>
    );
  };

  if (!call) return null;

  return (
    <Dialog 
      open={open} 
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: { minHeight: '60vh' }
      }}
    >
      <DialogTitle>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Box display="flex" alignItems="center" gap={1}>
            <DentalIcon color="primary" />
            <Typography variant="h6">Link to Patient Record</Typography>
          </Box>
          <IconButton onClick={onClose} size="small">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      
      <DialogContent dividers>
        {/* Call Info */}
        <Box 
          sx={{ 
            p: 2, 
            mb: 2, 
            bgcolor: 'background.default',
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider'
          }}
        >
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Call Information
          </Typography>
          <Typography fontWeight="medium">
            {call.caller_name || 'Unknown Caller'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {call.caller_number || 'No phone number'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {new Date(call.call_date).toLocaleString()}
          </Typography>
        </Box>

        {/* Error/Success Messages */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        
        {success && (
          <Alert severity="success" sx={{ mb: 2 }} icon={<CheckIcon />}>
            {success}
          </Alert>
        )}

        {/* Sync Options */}
        <Box sx={{ mb: 2 }}>
          <FormControlLabel
            control={
              <Checkbox 
                checked={syncNow} 
                onChange={(e) => setSyncNow(e.target.checked)}
                size="small"
              />
            }
            label="Sync to Open Dental CommLog immediately"
          />
          {syncNow && (
            <FormControlLabel
              control={
                <Checkbox 
                  checked={includeTranscript} 
                  onChange={(e) => setIncludeTranscript(e.target.checked)}
                  size="small"
                />
              }
              label="Include full transcript"
              sx={{ ml: 3 }}
            />
          )}
        </Box>

        {/* Suggested Patients */}
        {patientSuggestions.length > 0 && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Suggested Patients
            </Typography>
            <List disablePadding>
              {patientSuggestions.map((patient) => 
                renderPatientItem(patient, patient.matchType)
              )}
            </List>
          </Box>
        )}

        <Divider sx={{ my: 2 }} />

        {/* Search */}
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Search for Patient
        </Typography>
        
        <Box display="flex" gap={1} mb={2}>
          <TextField
            fullWidth
            size="small"
            placeholder="Search by name, phone, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
            }}
          />
          <Button
            variant="outlined"
            onClick={handleSearch}
            disabled={loading || searchQuery.length < 2}
          >
            {loading ? <CircularProgress size={20} /> : 'Search'}
          </Button>
        </Box>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              {searchResults.length} patient{searchResults.length !== 1 ? 's' : ''} found
            </Typography>
            <List disablePadding sx={{ mt: 1 }}>
              {searchResults.map((patient) => renderPatientItem(patient))}
            </List>
          </Box>
        )}

        {/* No Results */}
        {searchResults.length === 0 && searchQuery.length >= 2 && !loading && (
          <Box textAlign="center" py={3}>
            <Typography color="text.secondary">
              No patients found matching "{searchQuery}"
            </Typography>
          </Box>
        )}
      </DialogContent>
      
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default PatientLinkDialog;

